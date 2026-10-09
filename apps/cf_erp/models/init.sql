-- ============================================================================
-- cf_erp — core schema: classification, master records, specifications
-- ============================================================================
-- Built from ERP_Taxonomy_Summary_v3 + ERP_Database_Architecture (the 8-page
-- logical model). Every open decision behind this file is recorded, with its
-- reasoning, in TM/CF_ERP_PLAN.md — read that before changing a table here.
--
-- The model in one paragraph:
--   An ITEM is a real thing that transacts; a DEFINITION is a reusable
--   blueprint that never does. Both live in ONE base table (cf_master_records)
--   because a Template BOM line, a sales order line and a spec value must be
--   able to point at either through a single column. What only an item has
--   sits in cf_item_details; what only a definition has sits in
--   cf_definition_details. Anything that must only ever touch a real item —
--   stock, batches, units, production — references cf_item_details, never the
--   base table, so the database itself refuses to stock a definition.
--   Specifications are defined once (cf_specifications), attached to things by
--   a RULE (cf_spec_assignments) and hold their VALUE separately
--   (cf_spec_values), because a rule lives on a type while a value can live on
--   one batch or one physical unit.
--
-- Codes and names are NOT generated here. The code generator is a separate,
-- user-configurable module: modules/codegen/models/init.sql. Run it after this
-- file (its tables reference nothing here, but its token providers read these).
--
-- Customers, suppliers and subcontractors live in another separate module,
-- modules/parties/models/init.sql. Sales orders reference its table, so run it
-- BEFORE this file. Order: parties -> this file -> codegen.
--
-- Platform rules every table follows:
--   * company_id on every table, AND a `companyId` mapping in resourceDef.json —
--     the query engine only injects the tenant filter when it sees that mapping.
--   * deleted_at on every table — the query engine always appends
--     `deleted_at IS NULL` to the main table of a read.
--   * Soft-delete-aware uniqueness uses VIRTUAL generated columns that go NULL
--     when a row is deleted (`code_active`, `name_active`, `is_live`). MySQL never
--     compares NULLs in a unique index, so deleted rows never block a reuse, and
--     the platform's generic delete (which only sets deleted_at) needs no help.
--     Same pattern fab_erp runs in production today.
--   * Every reference between cf_ tables is a COMPOSITE foreign key on
--     (company_id, <ref>_id) -> (company_id, id). The database refuses a row in
--     company A that points at a row in company B. That matters here because
--     relation joins in the generic query API do not re-check company: a single
--     cross-tenant reference would surface the other tenant's names in a read.
--     Each referenced table therefore carries UNIQUE (company_id, id). A NULL
--     optional reference skips the check, as it should. Polymorphic references
--     (subject_type + subject_id) cannot have FKs; their services check company.
--
-- Production is TiDB v8.5.3 (checked 2026-09-22):
--   * foreign keys ARE enforced (foreign_key_checks = 1), so the FKs below are
--     real guarantees in prod, not documentation;
--   * CHECK constraints are NOT (tidb_enable_check_constraint = 0), so per-kind
--     rules ("a temporary item needs an owner") live in the service layer;
--   * there are NO triggers, so history rows are written by the service that
--     makes the change — never assume a write outside that service is audited.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS only. No DROPs in this file, ever.
-- ============================================================================


-- ===== 1. CLASSIFICATION — Family > Subfamily > Variant =====================
-- One tree shared by items and definitions (decision Q6) — and machines, whose
-- types are classified the same way (decided 2026-09-22), so machine specs are
-- assigned once per machine type. `scope` only filters pickers — it is not an
-- integrity rule; a temporary item deliberately sits under its definition's
-- node even when that node is scoped 'definition'. 'both' means items and
-- definitions; machine types are scoped 'machine'.
--
-- `depth` rather than a Family/Subfamily/Variant enum (decision Q17): the three
-- names are display labels for depth 0 / 1 / 2, so a fourth level later is a
-- constant change in the service, not a schema migration. The service keeps
-- depth = parent.depth + 1 and allows items and definitions only on the
-- deepest level (the Variant).
--
-- Codes are unique per company (they appear in generated codes and imports, so
-- they must mean one thing); names are unique among siblings only, so both
-- Steel > Plates > General and Fasteners > Bolts > General can exist.

CREATE TABLE IF NOT EXISTS cf_classification_nodes (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  parent_id     INT           NULL,                 -- NULL only at depth 0
  depth         TINYINT       NOT NULL,             -- 0 Family, 1 Subfamily, 2 Variant
  scope         ENUM('item','definition','both','machine') NOT NULL DEFAULT 'both',
  code          VARCHAR(50)   NOT NULL,
  name          VARCHAR(255)  NOT NULL,
  description   TEXT          NULL,
  sort_order    INT           NOT NULL DEFAULT 0,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  code_active   VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  name_active   VARCHAR(255)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,
  parent_key    INT           GENERATED ALWAYS AS (IFNULL(parent_id, 0)) VIRTUAL,

  UNIQUE KEY uq_ccn_tenant    (company_id, id),
  UNIQUE KEY uq_ccn_code      (company_id, code_active),
  UNIQUE KEY uq_ccn_sibling   (company_id, parent_key, name_active),
  KEY idx_ccn_parent  (company_id, parent_id),
  KEY idx_ccn_depth   (company_id, depth),

  CONSTRAINT fk_ccn_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccn_parent  FOREIGN KEY (company_id, parent_id) REFERENCES cf_classification_nodes(company_id, id),
  CONSTRAINT fk_ccn_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 2. MASTER RECORDS — the shared base for every Item and Definition =====
-- (Architecture p.2 "Master_Record".) Holds only what is true of both kinds.
-- Lifecycle lives here: deleting an item or definition soft-deletes this row
-- and its detail row together, in one service call.
--
-- `code` is one namespace across items AND definitions (decision Q1), so a code
-- on a BOM line is never ambiguous. It may be NULL only while status = 'draft':
-- a temporary item is born the moment its template line is added (Q21), which
-- can be before the code generator has the values its pattern needs.
--
-- `revision` is a plain attribute (decision Q2, "the Fable way"): the id never
-- changes; documents that use a record copy the revision they used. A new
-- revision is NOT a new row — otherwise every BOM line, production item and
-- stock piece on Rev A would have to be re-pointed when Rev B arrives.
--
-- `classification_id` is mandatory and must be a Variant (deepest level).
-- A temporary item takes its template definition's classification, set by the
-- service and not editable (Q20), so the two inheritance chains cannot disagree.

CREATE TABLE IF NOT EXISTS cf_master_records (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  record_kind        ENUM('item','definition') NOT NULL,
  code               VARCHAR(100)  NULL,            -- NULL only while draft
  name               VARCHAR(255)  NOT NULL,
  description        TEXT          NULL,
  classification_id  INT           NOT NULL,        -- a Variant
  status             ENUM('draft','active','obsolete') NOT NULL DEFAULT 'draft',
  revision           VARCHAR(20)   NULL,
  default_flow_id    INT           NULL,            -- how it is usually made; FK added in section 10

  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  code_active        VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cmr_tenant (company_id, id),
  UNIQUE KEY uq_cmr_code   (company_id, code_active),
  KEY idx_cmr_kind           (company_id, record_kind, status),
  KEY idx_cmr_classification (company_id, classification_id),

  CONSTRAINT fk_cmr_company        FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cmr_classification FOREIGN KEY (company_id, classification_id) REFERENCES cf_classification_nodes(company_id, id),
  CONSTRAINT fk_cmr_creator        FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 2a. Definition details — only definitions have a row here ------------
-- (Architecture p.2 "Definition_Detail".) The diagram's name_pattern and
-- code_pattern are deliberately NOT here: patterns belong to the code generator
-- module, which any entity can use, instead of being a column on one of them.
--
-- The selection columns mean something only when definition_type = 'selection'
-- (decision Q12). selection_mode says where candidates come from:
--   allowed_list — only the catalog items in cf_definition_allowed_items
--   spec_match   — any catalog item that satisfies cf_selection_criteria
--   both         — items on the list that ALSO satisfy the criteria
-- candidate_classification_id narrows spec matching to a subtree, so
-- "DIAMETER = 20" finds bolts rather than every 20 mm pin and rod.

CREATE TABLE IF NOT EXISTS cf_definition_details (
  master_id                    INT       PRIMARY KEY,
  company_id                   INT       NOT NULL,
  definition_type              ENUM('template','selection') NOT NULL,
  selection_mode               ENUM('allowed_list','spec_match','both') NULL,
  candidate_classification_id  INT       NULL,

  deleted_at                   DATETIME  DEFAULT NULL,
  created_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cdd_tenant (company_id, master_id),
  KEY idx_cdd_type      (company_id, definition_type),
  KEY idx_cdd_candidate (company_id, candidate_classification_id),

  CONSTRAINT fk_cdd_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  -- also guarantees the detail row belongs to the same company as its master
  CONSTRAINT fk_cdd_master    FOREIGN KEY (company_id, master_id) REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cdd_candidate FOREIGN KEY (company_id, candidate_classification_id) REFERENCES cf_classification_nodes(company_id, id)
);


-- ----- 2b. Item details — only items have a row here ------------------------
-- (Architecture p.2 "Item_Detail".) THE table stock, batches, individual units,
-- the ledger and production items will reference. Pointing those at this table
-- instead of cf_master_records is what makes "definitions never transact" a
-- database guarantee rather than a promise in code.
--
-- tracked_by sets how far inventory drills down (quantity -> batch -> unit),
-- and caps how deep a specification may be captured: no per-unit measured
-- length on an item tracked only by quantity (service rule).
--
-- Temporary-only columns (service rejects them on a catalog item):
--   source_definition_id — the Template Definition it was created from (gap G1,
--     decision Q4). Naming, Wait-For rules (Step_Wait_Rule.target_definition_id)
--     and spec inheritance all need it. The FK targets cf_definition_details, so
--     the database guarantees it is a definition; the service checks 'template'.
--   owner_order_line_id — the order line that owns it (gap G2, decision Q3).
--     Its FK is added in section 9b, once cf_sales_order_lines exists. Indexed,
--     because within a year most rows in this table will be temporary items and
--     "everything for this order" is the query that keeps pickers fast.
--
-- A temporary item is a DESIGN, not a piece (decision Q5): one per template BOM
-- line; that line's quantity is the number of identical pieces, which get their
-- physical identity as individual units, not as more rows here.

CREATE TABLE IF NOT EXISTS cf_item_details (
  master_id             INT          PRIMARY KEY,
  company_id            INT          NOT NULL,
  item_type             ENUM('catalog','temporary') NOT NULL,
  tracked_by            ENUM('quantity','batch','individual') NOT NULL DEFAULT 'quantity',
  uom                   VARCHAR(20)  NOT NULL DEFAULT 'nos',
  -- Where a catalog item comes from when an order asks for one (user, 2026-09-23):
  -- stock = always drawn from stock (a stock order is what makes it), make =
  -- always made on the order that needs it, both = from stock when there is free
  -- stock to cover it, else made. Temporary items are always made.
  sourcing              ENUM('stock','make','both') NOT NULL DEFAULT 'stock',
  source_definition_id  INT          NULL,          -- temporary only
  owner_order_line_id   INT          NULL,          -- temporary only; FK added in section 9b

  deleted_at            DATETIME     DEFAULT NULL,
  created_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cid_tenant (company_id, master_id),
  KEY idx_cid_type       (company_id, item_type),
  KEY idx_cid_source_def (company_id, source_definition_id),
  KEY idx_cid_owner      (company_id, owner_order_line_id),

  CONSTRAINT fk_cid_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cid_master     FOREIGN KEY (company_id, master_id) REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cid_source_def FOREIGN KEY (company_id, source_definition_id) REFERENCES cf_definition_details(company_id, master_id)
);


-- ===== 3. SPECIFICATION LIBRARY =============================================
-- (Architecture p.2 "Specification".) What is true of a specification
-- everywhere: identity, type, unit. No default, no formula, no required flag —
-- those differ per thing it is attached to, so they live on the assignment.
--
-- Units (decision Q11): each spec is locked to default_uom for now. Every value
-- still records its own uom, so unit conversion (via measurement_type) can be
-- added later without touching stored data.

CREATE TABLE IF NOT EXISTS cf_specifications (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  code              VARCHAR(100)  NOT NULL,         -- stable: THICKNESS, WEIGHT
  name              VARCHAR(255)  NOT NULL,
  data_type         ENUM('number','text','boolean','date','option') NOT NULL DEFAULT 'number',
  measurement_type  VARCHAR(30)   NULL,             -- LENGTH, MASS, AREA ... (validated in code)
  default_uom       VARCHAR(20)   NULL,             -- mm, kg ...
  decimals          TINYINT       NULL,             -- display precision, numbers only
  description       TEXT          NULL,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  code_active       VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_csp_tenant (company_id, id),
  UNIQUE KEY uq_csp_code   (company_id, code_active),
  KEY idx_csp_status (company_id, status),

  CONSTRAINT fk_csp_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csp_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 3a. Allowed values of an 'option' specification ----------------------
-- (Decision Q10.) The spec holds the full list; an assignment may narrow it via
-- cf_spec_assignment_options. Rows, not a JSON array, so a value can be retired
-- without rewriting every item that uses it, and "who uses E350?" is a lookup.

CREATE TABLE IF NOT EXISTS cf_spec_options (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  specification_id  INT           NOT NULL,
  value             VARCHAR(100)  NOT NULL,         -- stored value, e.g. E250
  label             VARCHAR(255)  NULL,             -- display text if different
  sort_order        INT           NOT NULL DEFAULT 0,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  value_active      VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(value), NULL)) VIRTUAL,

  UNIQUE KEY uq_cso_tenant (company_id, id),
  UNIQUE KEY uq_cso_value  (company_id, specification_id, value_active),

  CONSTRAINT fk_cso_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cso_spec    FOREIGN KEY (company_id, specification_id) REFERENCES cf_specifications(company_id, id),
  CONSTRAINT fk_cso_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 4. FORMULAS ==========================================================
-- (Architecture p.2 "Formula".) Reusable, shared by many assignments and later
-- by operation-machine timing (Work Time = Item.CUT_LENGTH / Machine.CUTTING_SPEED).
-- `version` is an attribute, like revision. Roll-ups are formulas too, and they
-- run over BOM lines x line quantity, not over child records (gap G5).

CREATE TABLE IF NOT EXISTS cf_formulas (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  code          VARCHAR(100)  NOT NULL,
  name          VARCHAR(255)  NOT NULL,
  expression    TEXT          NOT NULL,
  version       INT           NOT NULL DEFAULT 1,
  description   TEXT          NULL,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  code_active   VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cfm_tenant (company_id, id),
  UNIQUE KEY uq_cfm_code   (company_id, code_active),

  CONSTRAINT fk_cfm_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cfm_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 5. SPECIFICATION ASSIGNMENTS — the RULE ==============================
-- (Architecture p.2 "Specification_Assignment".) Says that a spec applies to a
-- subject, whether it is required, at what level it is captured, and how its
-- value is obtained. It holds no value (see cf_spec_values).
--
-- Subjects: a classification node, a master record (item or definition), or a
-- machine (reserved now, built later — decision Q22). Resolution for a record
-- walks Family -> Subfamily -> Variant -> [its Template Definition, for a
-- temporary item] -> the record itself (decision Q4), and the most specific
-- assignment of a (spec, capture_at) pair wins. is_applicable = 0 at a lower
-- level switches an inherited spec off (Q9).
--
-- value_rule (taxonomy §6, with Fixed and Defaulted split — decision Q8):
--   entered    user enters it
--   fixed      a value set higher up; lower levels cannot override
--   defaulted  a value set higher up; lower levels can override
--   calculated formula over specs of the same thing
--   rollup     formula over BOM children x line quantity
--   inherited  taken from the BOM parent — a Web takes its Girder's grade (Q7)
--
-- The unique key includes capture_at (decision Q16): WEIGHT can be 'calculated'
-- at item level (nominal) and 'entered' at individual level (weighed) on the
-- same subject — same spec, two rules.

CREATE TABLE IF NOT EXISTS cf_spec_assignments (
  id                INT        AUTO_INCREMENT PRIMARY KEY,
  company_id        INT        NOT NULL,
  specification_id  INT        NOT NULL,
  subject_type      ENUM('classification','master','machine') NOT NULL,
  subject_id        INT        NOT NULL,
  capture_at        ENUM('item','batch','individual') NOT NULL DEFAULT 'item',
  is_required       TINYINT(1) NOT NULL DEFAULT 0,
  is_applicable     TINYINT(1) NOT NULL DEFAULT 1,
  value_rule        ENUM('entered','fixed','defaulted','calculated','rollup','inherited')
                               NOT NULL DEFAULT 'entered',
  formula_id        INT        NULL,               -- calculated / rollup
  sort_order        INT        NOT NULL DEFAULT 0,

  deleted_at        DATETIME   DEFAULT NULL,
  created_at        TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT        NULL,

  is_live           TINYINT    GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_csa_tenant (company_id, id),
  UNIQUE KEY uq_csa_rule   (company_id, specification_id, subject_type, subject_id, capture_at, is_live),
  KEY idx_csa_subject (company_id, subject_type, subject_id),
  KEY idx_csa_formula (company_id, formula_id),

  CONSTRAINT fk_csa_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csa_spec    FOREIGN KEY (company_id, specification_id) REFERENCES cf_specifications(company_id, id),
  CONSTRAINT fk_csa_formula FOREIGN KEY (company_id, formula_id)       REFERENCES cf_formulas(company_id, id),
  CONSTRAINT fk_csa_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 5a. Narrowed option list for one assignment --------------------------
-- (Decision Q10.) No rows = every option of the spec is allowed. Rows = only
-- these (plates allow E250 / E350 out of all steel grades).

CREATE TABLE IF NOT EXISTS cf_spec_assignment_options (
  id             INT       AUTO_INCREMENT PRIMARY KEY,
  company_id     INT       NOT NULL,
  assignment_id  INT       NOT NULL,
  option_id      INT       NOT NULL,

  deleted_at     DATETIME  DEFAULT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT       NULL,

  is_live        TINYINT   GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_csao_pair (company_id, assignment_id, option_id, is_live),
  KEY idx_csao_option (company_id, option_id),

  CONSTRAINT fk_csao_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csao_assignment FOREIGN KEY (company_id, assignment_id) REFERENCES cf_spec_assignments(company_id, id),
  CONSTRAINT fk_csao_option     FOREIGN KEY (company_id, option_id)     REFERENCES cf_spec_options(company_id, id),
  CONSTRAINT fk_csao_creator    FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 6. SPECIFICATION VALUES — the VALUE ==================================
-- (Architecture p.2 "Specification_Value".) One value of one spec on one
-- subject. A value can sit at any level (decision Q8): on a classification node
-- or a definition it is the fixed / default value for everything below; on an
-- item it is that item's value; on a batch (Heat No.) or an individual unit
-- (measured weight) it is captured there. Batch and unit subjects are reserved
-- now; their tables arrive with Inventory.
--
-- Typed columns, exactly one used per row, chosen by the spec's data_type —
-- WEIGHT must sum as a number for roll-ups and spec matching to mean anything.
-- 'option' specs store option_id, never the text, so renaming an option cannot
-- leave stale copies behind.
--
-- Computed values are STORED, not computed on read (decision Q18), and `source`
-- records which rule produced the value — it uses the same words as value_rule.
-- A weighed 25.2 kg (entered) and a calculated 25.2 kg (calculated) are
-- different facts; a defaulted value the user then changed becomes 'entered'.
--
-- The two indexes on (specification_id, value) serve spec matching ("plates
-- with THICKNESS = 12 AND GRADE = E250" is one EXISTS per condition).
--
-- Every write goes through the value service, which also writes
-- cf_spec_value_history in the same transaction (TiDB has no triggers).

CREATE TABLE IF NOT EXISTS cf_spec_values (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  specification_id  INT            NOT NULL,
  subject_type      ENUM('classification','master','batch','unit','machine') NOT NULL,
  subject_id        INT            NOT NULL,

  value_number      DECIMAL(24,6)  NULL,
  value_text        VARCHAR(500)   NULL,
  value_bool        TINYINT(1)     NULL,
  value_date        DATE           NULL,
  option_id         INT            NULL,
  uom               VARCHAR(20)    NULL,
  source            ENUM('entered','fixed','defaulted','calculated','rollup','inherited')
                                   NOT NULL DEFAULT 'entered',

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  is_live           TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_csv_tenant (company_id, id),
  UNIQUE KEY uq_csv_value  (company_id, specification_id, subject_type, subject_id, is_live),
  KEY idx_csv_subject (company_id, subject_type, subject_id),
  KEY idx_csv_number  (company_id, specification_id, value_number),
  KEY idx_csv_text    (company_id, specification_id, value_text),
  KEY idx_csv_option  (company_id, option_id),

  CONSTRAINT fk_csv_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csv_spec    FOREIGN KEY (company_id, specification_id) REFERENCES cf_specifications(company_id, id),
  CONSTRAINT fk_csv_option  FOREIGN KEY (company_id, option_id)        REFERENCES cf_spec_options(company_id, id),
  CONSTRAINT fk_csv_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 6a. Value history — append-only --------------------------------------
-- (Decision Q19.) Who changed which value, when, from what to what. Written by
-- the value service in the same transaction as the change; rows are never
-- updated or deleted (deleted_at exists only because the query engine requires
-- the column). Subject columns are copied in so "history of this item" works
-- even after the value row itself is deleted. Values as JSON
-- ({number, text, bool, date, option_id, uom, source}) because history is read
-- by people, not filtered by value.

CREATE TABLE IF NOT EXISTS cf_spec_value_history (
  id                INT       AUTO_INCREMENT PRIMARY KEY,
  company_id        INT       NOT NULL,
  value_id          INT       NOT NULL,
  specification_id  INT       NOT NULL,
  subject_type      ENUM('classification','master','batch','unit','machine') NOT NULL,
  subject_id        INT       NOT NULL,
  change_type       ENUM('create','update','delete') NOT NULL,
  old_value         JSON      NULL,
  new_value         JSON      NULL,
  changed_by        INT       NULL,
  changed_at        DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  deleted_at        DATETIME  DEFAULT NULL,           -- never set; required by the query engine

  KEY idx_csvh_subject (company_id, subject_type, subject_id, changed_at),
  KEY idx_csvh_value   (company_id, value_id),
  KEY idx_csvh_spec    (company_id, specification_id),

  CONSTRAINT fk_csvh_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csvh_value   FOREIGN KEY (company_id, value_id)         REFERENCES cf_spec_values(company_id, id),
  CONSTRAINT fk_csvh_spec    FOREIGN KEY (company_id, specification_id) REFERENCES cf_specifications(company_id, id),
  CONSTRAINT fk_csvh_user    FOREIGN KEY (changed_by) REFERENCES users(id)
);


-- ===== 7. SELECTION DEFINITIONS — how a catalog item is chosen ==============
-- (Gap G4, decision Q12.) Both belong to a definition whose type is
-- 'selection' (service rule). Their FKs point at the DETAIL tables, so the
-- database guarantees the definition side is a definition and the item side is
-- an item; 'catalog' is checked by the service.

-- ----- 7a. Allowed list ------------------------------------------------------
CREATE TABLE IF NOT EXISTS cf_definition_allowed_items (
  id             INT        AUTO_INCREMENT PRIMARY KEY,
  company_id     INT        NOT NULL,
  definition_id  INT        NOT NULL,              -- a selection definition
  item_id        INT        NOT NULL,              -- a catalog item
  is_default     TINYINT(1) NOT NULL DEFAULT 0,
  sort_order     INT        NOT NULL DEFAULT 0,

  deleted_at     DATETIME   DEFAULT NULL,
  created_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT        NULL,

  is_live        TINYINT    GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cdai_pair (company_id, definition_id, item_id, is_live),
  KEY idx_cdai_item (company_id, item_id),

  CONSTRAINT fk_cdai_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cdai_def     FOREIGN KEY (company_id, definition_id) REFERENCES cf_definition_details(company_id, master_id),
  CONSTRAINT fk_cdai_item    FOREIGN KEY (company_id, item_id)       REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cdai_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 7b. Matching criteria -------------------------------------------------
-- One row per condition. Rows on the SAME spec are OR'ed (GRADE = 8.8 or 10.9);
-- rows on DIFFERENT specs are AND'ed (... and DIAMETER = 20). 'between' uses
-- value_number .. value_number_to. Option specs compare option_id.

CREATE TABLE IF NOT EXISTS cf_selection_criteria (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  definition_id     INT            NOT NULL,        -- a selection definition
  specification_id  INT            NOT NULL,
  operator          ENUM('eq','neq','gt','gte','lt','lte','between') NOT NULL DEFAULT 'eq',
  value_number      DECIMAL(24,6)  NULL,
  value_number_to   DECIMAL(24,6)  NULL,            -- 'between' upper bound
  value_text        VARCHAR(500)   NULL,
  value_bool        TINYINT(1)     NULL,
  value_date        DATE           NULL,
  option_id         INT            NULL,
  sort_order        INT            NOT NULL DEFAULT 0,

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  KEY idx_csc_def    (company_id, definition_id),
  KEY idx_csc_spec   (company_id, specification_id),
  KEY idx_csc_option (company_id, option_id),

  CONSTRAINT fk_csc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csc_def     FOREIGN KEY (company_id, definition_id)    REFERENCES cf_definition_details(company_id, master_id),
  CONSTRAINT fk_csc_spec    FOREIGN KEY (company_id, specification_id) REFERENCES cf_specifications(company_id, id),
  CONSTRAINT fk_csc_option  FOREIGN KEY (company_id, option_id)        REFERENCES cf_spec_options(company_id, id),
  CONSTRAINT fk_csc_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 8. BOMs — what a parent is made of ===================================
-- (Architecture p.3 "BOM_Header" / "BOM_Line"; taxonomy §3.) One BOM engine;
-- the parent decides how it behaves:
--   catalog item        -> Standard BOM  (children: catalog items only)
--   template definition -> Template BOM  (children: catalog items, template and
--                                         selection definitions)
--   temporary item      -> Custom BOM    (children: catalog items, the temporary
--                                         items it created, selection
--                                         definitions until a catalog item is chosen)
-- A selection definition never has a BOM.
--
-- A BOM stores only the IMMEDIATE children of one parent; the full structure is
-- recursive (a child can have its own BOM). One live BOM per parent. bom_type
-- is stored for filtering but always equals what the parent's kind says — the
-- service sets it, and nothing changes a parent's kind.
--
-- parent_id is a plain FK to the master table (decision Q15): every parent the
-- architecture lists is a master record.
--
-- revision and status work like the masters' (Q2): the id never changes and
-- documents record the revision they used. A Custom BOM has no status of its own
-- to set — it follows its order (release arrives in a later phase).
--
-- source_bom_id: the BOM this one was copied from (a Custom BOM from its Template
-- BOM). Provenance only — nothing follows the source afterwards.

CREATE TABLE IF NOT EXISTS cf_boms (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  company_id     INT          NOT NULL,
  parent_id      INT          NOT NULL,
  bom_type       ENUM('standard','template','custom') NOT NULL,
  revision       VARCHAR(20)  NULL,
  status         ENUM('draft','active','obsolete') NOT NULL DEFAULT 'draft',
  source_bom_id  INT          NULL,
  notes          TEXT         NULL,

  deleted_at     DATETIME     DEFAULT NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT          NULL,

  is_live        TINYINT      GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cbm_tenant (company_id, id),
  UNIQUE KEY uq_cbm_parent (company_id, parent_id, is_live),
  KEY idx_cbm_type (company_id, bom_type, status),

  CONSTRAINT fk_cbm_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cbm_parent  FOREIGN KEY (company_id, parent_id)     REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cbm_source  FOREIGN KEY (company_id, source_bom_id) REFERENCES cf_boms(company_id, id),
  CONSTRAINT fk_cbm_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 8a. BOM lines — one child of one parent -------------------------------
-- quantity is per ONE parent (a girder has 6 stiffeners). Roll-ups use it as it
-- is (weight per girder); execution multiplies it down the path to get pieces for
-- the whole order. Keep the two apart — fab_erp under-planned by mixing them.
--
-- line_no orders the lines (10, 20, 30 leaves room to insert).
--
-- design_id + position number the lines that share a design within this BOM:
-- design_id is the definition (template or selection) or catalog item a line is
-- an instance of, and position counts within it — Web 01, Web 02; Flange 01,
-- Flange 02. Generated codes are built from position (P100-G01-WEB01), so it is
-- stored when the line is created and NEVER renumbered: deleting Web 01 does not
-- turn Web 02 into Web 01, and a new web line takes the next number, never a
-- deleted one's. The unique key deliberately covers deleted rows too.
--
-- A temporary item is a DESIGN, not a piece (Q5): one per template line, and the
-- line's quantity is the number of identical pieces.
--
-- selection_definition_id: on a Custom BOM line copied from a selection, the
-- selection it has to satisfy (Q12). child_id is the selection itself until a
-- catalog item is chosen, then that item — the line keeps both, so "this was a
-- bolt selection" is never lost. Release will require every child to be an item.
--
-- source_line_id: the Template BOM line a Custom BOM line was copied from.

CREATE TABLE IF NOT EXISTS cf_bom_lines (
  id                       INT            AUTO_INCREMENT PRIMARY KEY,
  company_id               INT            NOT NULL,
  bom_id                   INT            NOT NULL,
  line_no                  INT            NOT NULL,
  child_id                 INT            NOT NULL,
  design_id                INT            NOT NULL,
  position                 INT            NOT NULL,
  role                     VARCHAR(100)   NULL,
  quantity                 DECIMAL(18,6)  NOT NULL,
  selection_definition_id  INT            NULL,
  source_line_id           INT            NULL,
  operation_flow_id        INT            NULL,       -- how this child is made in this parent; FK added in section 10
  notes                    TEXT           NULL,

  deleted_at               DATETIME       DEFAULT NULL,
  created_at               TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by               INT            NULL,

  is_live                  TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cbl_tenant   (company_id, id),
  UNIQUE KEY uq_cbl_line_no  (company_id, bom_id, line_no, is_live),
  UNIQUE KEY uq_cbl_position (company_id, bom_id, design_id, position),
  KEY idx_cbl_child     (company_id, child_id),
  KEY idx_cbl_design    (company_id, design_id),
  KEY idx_cbl_selection (company_id, selection_definition_id),

  CONSTRAINT fk_cbl_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cbl_bom       FOREIGN KEY (company_id, bom_id)                  REFERENCES cf_boms(company_id, id),
  CONSTRAINT fk_cbl_child     FOREIGN KEY (company_id, child_id)                REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cbl_design    FOREIGN KEY (company_id, design_id)               REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cbl_selection FOREIGN KEY (company_id, selection_definition_id) REFERENCES cf_definition_details(company_id, master_id),
  CONSTRAINT fk_cbl_source    FOREIGN KEY (company_id, source_line_id)          REFERENCES cf_bom_lines(company_id, id),
  CONSTRAINT fk_cbl_creator   FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 9. SALES ORDERS — the project ========================================
-- (Architecture p.3 "Customer_Inquiry" / "Sales_Order" / "Sales_Order_Line".)
-- Decided 2026-09-22: there is no project above the sales order — the sales
-- order IS the project. A customer inquiry is not a separate document but the
-- first stages of the same record, because design work (Custom BOMs, temporary
-- items) starts during estimation and nothing should be copied across when an
-- inquiry converts.
--
-- order_type (decided 2026-09-22 — standard products are also made for stock):
--   customer  inquiry -> quoted -> confirmed -> closed; or lost; or cancelled
--   stock     draft -> confirmed -> closed; or cancelled. No customer, and only
--             standard lines. Every production run therefore hangs off an
--             order line, whoever it is for.
--
-- code is one number for life, from the first inquiry: temporary item codes are
-- built from it (P100-G01-WEB01), so it cannot change when the inquiry
-- converts. The service fixes it once the order has lines.
--
-- status is the commercial lifecycle, set by people. Production progress will be
-- derived from execution records and never set by hand.
--
-- customer_id -> cf_parties, the separate parties module (run before this file).

CREATE TABLE IF NOT EXISTS cf_sales_orders (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  code                VARCHAR(100)  NOT NULL,
  order_type          ENUM('customer','stock') NOT NULL DEFAULT 'customer',
  title               VARCHAR(255)  NULL,
  customer_id         INT           NULL,             -- customer orders only
  customer_reference  VARCHAR(100)  NULL,             -- the customer's enquiry / PO number
  status              ENUM('draft','inquiry','quoted','confirmed','closed','lost','cancelled') NOT NULL,
  received_on         DATE          NULL,
  committed_date      DATE          NULL,
  confirmed_at        DATETIME      NULL,
  delivery_address    TEXT          NULL,
  notes               TEXT          NULL,

  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT           NULL,

  code_active         VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_csor_tenant (company_id, id),
  UNIQUE KEY uq_csor_code   (company_id, code_active),
  KEY idx_csor_status   (company_id, order_type, status),
  KEY idx_csor_customer (company_id, customer_id),
  KEY idx_csor_committed (company_id, committed_date),

  CONSTRAINT fk_csor_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csor_customer FOREIGN KEY (company_id, customer_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_csor_creator  FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 9a. Sales order lines ---------------------------------------------------
-- A line always sells an ITEM:
--   standard  a catalog item, made or bought as it is; bom_revision records the
--             Standard BOM revision it was taken at (documents record the
--             revision they used, Q2)
--   custom    the temporary item created when the line chose a template
--             definition (Q21: at once, as a draft), whose Custom BOM is copied
--             from the definition's Template BOM
-- So one pointer, item_id -> item details. The drawn source_master_id +
-- custom_bom_id collapse into it: the template is on the temporary item
-- (source_definition_id), and the Custom BOM is that item's BOM.
--
-- item_id is NULL only inside the transaction that creates a custom line: the
-- temporary item needs the line to exist first (it is the item's owner), and the
-- line needs the item. The service fills it before committing.
--
-- quantity = identical copies of the item (Q5): two identical girders are one
-- line of 2; two different girders are two lines.
--
-- design_id + position number the lines that sell the same design within the
-- order (Girder 01, Girder 02) — the template definition for a custom line, the
-- catalog item for a standard one. The root temporary item's code is built from
-- it, so it is stored once and never renumbered, like BOM line positions.

CREATE TABLE IF NOT EXISTS cf_sales_order_lines (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_id        INT            NOT NULL,
  line_no         INT            NOT NULL,
  line_type       ENUM('standard','custom') NOT NULL,
  item_id         INT            NULL,
  design_id       INT            NOT NULL,
  position        INT            NOT NULL,
  quantity        DECIMAL(18,6)  NOT NULL,
  committed_date  DATE           NULL,
  bom_revision    VARCHAR(20)    NULL,
  description     VARCHAR(500)   NULL,
  notes           TEXT           NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  is_live         TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_csol_tenant   (company_id, id),
  UNIQUE KEY uq_csol_line_no  (company_id, order_id, line_no, is_live),
  UNIQUE KEY uq_csol_position (company_id, order_id, design_id, position),
  KEY idx_csol_order (company_id, order_id),
  KEY idx_csol_item  (company_id, item_id),

  CONSTRAINT fk_csol_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csol_order   FOREIGN KEY (company_id, order_id)  REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_csol_item    FOREIGN KEY (company_id, item_id)   REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_csol_design  FOREIGN KEY (company_id, design_id) REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_csol_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 9b. A temporary item's owner line — the FK promised in section 2b --------
-- Added after both tables exist (each references the other). Guarded, so the
-- file stays safe to re-run.
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'cf_item_details'
              AND CONSTRAINT_NAME = 'fk_cid_owner_line');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_item_details ADD CONSTRAINT fk_cid_owner_line FOREIGN KEY (company_id, owner_order_line_id) REFERENCES cf_sales_order_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 10. PRODUCTION SETUP — operations, flows, machines =====================
-- (Architecture p.5.) The reusable description of HOW things are made. Nothing
-- here is a piece of work: release (a later phase) turns an item's flow into
-- steps of the production tracker and Wait-For rules into dependencies between
-- tracker nodes — parent and child in that tree define who waits for whom
-- (decided 2026-09-22).

-- ----- 10a. Operations — what can be done -------------------------------------
CREATE TABLE IF NOT EXISTS cf_operations (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  code         VARCHAR(50)   NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  description  TEXT          NULL,
  status       ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  code_active  VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cop_tenant (company_id, id),
  UNIQUE KEY uq_cop_code   (company_id, code_active),

  CONSTRAINT fk_cop_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cop_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 10b. Operation flows — the usual way to make something -----------------
-- A flow is an ordered list of operations. Revision and status work like the
-- masters' (Q2): same row, the label moves on; released work keeps what it was
-- given.
CREATE TABLE IF NOT EXISTS cf_operation_flows (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  code         VARCHAR(50)   NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  description  TEXT          NULL,
  revision     VARCHAR(20)   NULL,
  status       ENUM('draft','active','obsolete') NOT NULL DEFAULT 'draft',

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  code_active  VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cof_tenant (company_id, id),
  UNIQUE KEY uq_cof_code   (company_id, code_active),

  CONSTRAINT fk_cof_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cof_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 10c. Flow steps ------------------------------------------------------------
-- `sequence` orders the steps; steps with the SAME number may run in parallel.
-- There is no free-form list of predecessors inside a flow — fab_erp's
-- depends_on list of sequence numbers was its most fragile part. Ordering
-- BETWEEN items comes from the tree and the Wait-For rules.
--
-- A flow MAY run the same operation more than once (changed 2026-09-24). A
-- plate girder is welded on one side, crane-turned, and welded on the other:
-- two steps of ONE operation with a turn between them. Naming them SAW-1 and
-- SAW-2 would put the sequence inside the operation's identity and break the
-- day a job needs a third pass. Importing the real fab_erp flows under the old
-- rule, 43 steps collapsed to 27.
--
-- So what identifies a step within a flow is its SEQUENCE, not its operation.
-- uq_cofs_operation_seq keeps the repeats strictly ordered: an operation may
-- appear many times, never twice at the SAME sequence number — steps sharing a
-- number run in parallel, and welding one piece twice at once is not a thing.
-- That ordering is what makes "the first pass" and "the last pass" well defined
-- for a Wait-For rule below (see services/flowService.js for which one a rule
-- means).
CREATE TABLE IF NOT EXISTS cf_operation_flow_steps (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  flow_id       INT           NOT NULL,
  sequence      INT           NOT NULL,
  operation_id  INT           NOT NULL,
  step_name     VARCHAR(100)  NULL,
  notes         TEXT          NULL,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  is_live       TINYINT       GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cofs_tenant    (company_id, id),
  UNIQUE KEY uq_cofs_operation_seq (company_id, flow_id, operation_id, sequence, is_live),
  KEY idx_cofs_flow (company_id, flow_id, sequence),
  KEY idx_cofs_operation (company_id, operation_id),

  CONSTRAINT fk_cofs_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cofs_flow      FOREIGN KEY (company_id, flow_id)      REFERENCES cf_operation_flows(company_id, id),
  CONSTRAINT fk_cofs_operation FOREIGN KEY (company_id, operation_id) REFERENCES cf_operations(company_id, id),
  CONSTRAINT fk_cofs_creator   FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 10d. Wait-For rules — relative dependencies (Architecture p.5, p.7) ------
-- Stored once on the WAITING step and resolved later, on the production
-- tracker tree, to real dependencies: "my parent must finish Alignment" becomes
-- "S01 Final Drilling waits for L01 Alignment". Waits interleave both ways,
-- mid-flow and as often as the job needs (user, 2026-09-22):
--   relation  parent    the tracker node above
--             children  the nodes directly below (all of them, or those made
--                       from target_definition_id)
--             siblings  the other nodes under the same parent (same filter)
--             ancestor  the nearest node above made from target_definition_id
--   target_operation_id  the step to wait for; NULL = the target as a whole
--   required_status      started | done
-- A parent's first step waits for a child to be complete only when none of the
-- parent's own rules names that child — so a half-set-up pair fails loudly at
-- release instead of silently not waiting (Phase 2 §3).
CREATE TABLE IF NOT EXISTS cf_step_wait_rules (
  id                    INT        AUTO_INCREMENT PRIMARY KEY,
  company_id            INT        NOT NULL,
  flow_step_id          INT        NOT NULL,
  relation              ENUM('parent','children','siblings','ancestor','descendants') NOT NULL,
  target_definition_id  INT        NULL,
  target_operation_id   INT        NULL,
  required_status       ENUM('started','done') NOT NULL DEFAULT 'done',
  notes                 TEXT       NULL,

  deleted_at            DATETIME   DEFAULT NULL,
  created_at            TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by            INT        NULL,

  is_live               TINYINT    GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  definition_key        INT        GENERATED ALWAYS AS (IFNULL(target_definition_id, 0)) VIRTUAL,
  operation_key         INT        GENERATED ALWAYS AS (IFNULL(target_operation_id, 0)) VIRTUAL,

  UNIQUE KEY uq_cswr_tenant (company_id, id),
  UNIQUE KEY uq_cswr_rule   (company_id, flow_step_id, relation, definition_key, operation_key, is_live),
  KEY idx_cswr_definition (company_id, target_definition_id),
  KEY idx_cswr_operation  (company_id, target_operation_id),

  CONSTRAINT fk_cswr_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cswr_step       FOREIGN KEY (company_id, flow_step_id)         REFERENCES cf_operation_flow_steps(company_id, id),
  CONSTRAINT fk_cswr_definition FOREIGN KEY (company_id, target_definition_id) REFERENCES cf_definition_details(company_id, master_id),
  CONSTRAINT fk_cswr_operation  FOREIGN KEY (company_id, target_operation_id)  REFERENCES cf_operations(company_id, id),
  CONSTRAINT fk_cswr_creator    FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 10e. Machines — their own master (decided 2026-09-22) ----------------------
-- Scheduled, not counted, so not catalog items: that keeps them out of every
-- material picker and stock report. Each machine sits on a machine TYPE — a
-- leaf of the shared classification tree — so specifications (CUTTING_SPEED,
-- MAX_THICKNESS) are assigned once per type and overridden per machine only
-- where it differs. catalog_item_id optionally names the catalog item it was
-- bought as. Where it stands (plant, shop, bay) arrives with the location tree.
CREATE TABLE IF NOT EXISTS cf_machines (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  code               VARCHAR(50)   NOT NULL,
  name               VARCHAR(255)  NOT NULL,
  classification_id  INT           NOT NULL,       -- the machine type (a leaf)
  catalog_item_id    INT           NULL,           -- what it was bought as
  serial_number      VARCHAR(100)  NULL,
  status             ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes              TEXT          NULL,

  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  code_active        VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cmc_tenant (company_id, id),
  UNIQUE KEY uq_cmc_code   (company_id, code_active),
  KEY idx_cmc_classification (company_id, classification_id),

  CONSTRAINT fk_cmc_company        FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cmc_classification FOREIGN KEY (company_id, classification_id) REFERENCES cf_classification_nodes(company_id, id),
  CONSTRAINT fk_cmc_catalog_item   FOREIGN KEY (company_id, catalog_item_id)   REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cmc_creator        FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 10f. Which machines can do an operation, and how long it takes -------------
-- (Architecture p.5 "Operation_Machine".) Set per machine TYPE — any level of
-- the tree, so "every cutting machine" is one row — and optionally per machine;
-- for one machine the most specific row valid on the day wins, the way spec
-- rules do. eligible = 0 on a deeper row takes a machine or type out.
-- Each time is a constant OR a formula (neither = none). Work time is per
-- piece; setup is per run; the step multiplies. Formulas read item.<SPEC> and
-- machine.<SPEC> — "Work Time = item.CUT_LENGTH / machine.CUTTING_SPEED" — so
-- one row gives each machine its own time from its own specs. Minutes.
CREATE TABLE IF NOT EXISTS cf_operation_machine_rules (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  operation_id      INT            NOT NULL,
  subject_type      ENUM('classification','machine') NOT NULL,
  subject_id        INT            NOT NULL,
  eligible          TINYINT(1)     NOT NULL DEFAULT 1,
  setup_minutes     DECIMAL(12,4)  NULL,
  setup_formula_id  INT            NULL,
  work_minutes      DECIMAL(12,4)  NULL,
  work_formula_id   INT            NULL,
  effective_from    DATE           NULL,
  effective_to      DATE           NULL,
  notes             TEXT           NULL,

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  is_live           TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  from_key          DATE           GENERATED ALWAYS AS (IFNULL(effective_from, '1000-01-01')) VIRTUAL,

  UNIQUE KEY uq_comr_tenant (company_id, id),
  UNIQUE KEY uq_comr_rule   (company_id, operation_id, subject_type, subject_id, from_key, is_live),
  KEY idx_comr_subject (company_id, subject_type, subject_id),
  KEY idx_comr_formulas (company_id, setup_formula_id, work_formula_id),

  CONSTRAINT fk_comr_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_comr_operation FOREIGN KEY (company_id, operation_id)     REFERENCES cf_operations(company_id, id),
  CONSTRAINT fk_comr_setup_f   FOREIGN KEY (company_id, setup_formula_id) REFERENCES cf_formulas(company_id, id),
  CONSTRAINT fk_comr_work_f    FOREIGN KEY (company_id, work_formula_id)  REFERENCES cf_formulas(company_id, id),
  CONSTRAINT fk_comr_creator   FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 10g. Columns and keys added to earlier tables ---------------------------------
-- Guarded, so the file stays safe to re-run on a database created before them.
-- Machine types in the shared tree:
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_classification_nodes'
               AND COLUMN_NAME = 'scope' AND COLUMN_TYPE LIKE '%machine%');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_classification_nodes MODIFY COLUMN scope ENUM('item','definition','both','machine') NOT NULL DEFAULT 'both'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- How an item or template is usually made (its flow when nothing more specific says):
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_master_records' AND COLUMN_NAME = 'default_flow_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_master_records ADD COLUMN default_flow_id INT NULL AFTER revision', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_master_records' AND CONSTRAINT_NAME = 'fk_cmr_default_flow');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_master_records ADD CONSTRAINT fk_cmr_default_flow FOREIGN KEY (company_id, default_flow_id) REFERENCES cf_operation_flows(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- How a child is made in THIS parent — beats the item's own default (fab_erp moved
-- default flows onto the BOM line for exactly this: a flange in a girder is not
-- made like a flange sold loose):
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_bom_lines' AND COLUMN_NAME = 'operation_flow_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_bom_lines ADD COLUMN operation_flow_id INT NULL AFTER source_line_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_bom_lines' AND CONSTRAINT_NAME = 'fk_cbl_flow');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_bom_lines ADD CONSTRAINT fk_cbl_flow FOREIGN KEY (company_id, operation_flow_id) REFERENCES cf_operation_flows(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================================
-- 11. Machine shifts (decided 2026-09-22: "shifts will change per machine")
-- ============================================================================
-- Each machine keeps its own shift patterns — no plant calendar underneath.
-- A pattern is a weekly rhythm (Day 08:00-16:00 Mon-Sat); exceptions change one
-- day (a holiday, a breakdown, an overtime shift). A shift belongs to the day it
-- STARTS, so a night shift 22:00-06:00 is one shift, never two half-shifts
-- (fab_erp's night-shift trap).

-- ----- 11a. Weekly shift patterns ---------------------------------------------
-- end_time <= start_time means the shift runs past midnight. break_minutes come
-- off the shift's working minutes. Patterns of one machine may not overlap
-- (checked by the service, which sees the weekday wrap and the date ranges).
CREATE TABLE IF NOT EXISTS cf_machine_shifts (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  machine_id      INT           NOT NULL,
  name            VARCHAR(50)   NOT NULL,       -- Day, Night, General
  weekdays        SET('mon','tue','wed','thu','fri','sat','sun') NOT NULL,
  start_time      TIME          NOT NULL,
  end_time        TIME          NOT NULL,
  break_minutes   INT           NOT NULL DEFAULT 0,
  effective_from  DATE          NULL,
  effective_to    DATE          NULL,
  sort_order      INT           NOT NULL DEFAULT 0,
  notes           TEXT          NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  UNIQUE KEY uq_cms_tenant (company_id, id),
  KEY idx_cms_machine (company_id, machine_id),

  CONSTRAINT fk_cms_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cms_machine FOREIGN KEY (company_id, machine_id) REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_cms_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 11b. One-day exceptions ------------------------------------------------
--   closed, no shift, no times  -> the machine does not work that day
--   closed, shift_id            -> that one shift is off
--   closed, start/end           -> a stoppage inside the day (breakdown 10:00-14:00)
--   extra, start/end            -> an extra window (overtime)
-- Times are on exception_date's clock; end <= start runs past midnight.
CREATE TABLE IF NOT EXISTS cf_machine_calendar_exceptions (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  machine_id      INT           NOT NULL,
  exception_date  DATE          NOT NULL,
  kind            ENUM('closed','extra') NOT NULL,
  shift_id        INT           NULL,
  start_time      TIME          NULL,
  end_time        TIME          NULL,
  reason          VARCHAR(255)  NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  UNIQUE KEY uq_cmce_tenant (company_id, id),
  KEY idx_cmce_day (company_id, machine_id, exception_date),

  CONSTRAINT fk_cmce_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cmce_machine FOREIGN KEY (company_id, machine_id) REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_cmce_shift   FOREIGN KEY (company_id, shift_id)   REFERENCES cf_machine_shifts(company_id, id),
  CONSTRAINT fk_cmce_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ============================================================================
-- 12. Inventory (decided 2026-09-22: "each stocking area will have an
--     inventory; stock can be at an item or its batch level; items are per
--     stock size")
-- ============================================================================
-- The ledger is the truth: every movement writes signed rows per stocking area
-- (+ in, - out), never edited. The balance table is a cache of the ledger,
-- written by the same service in the same transaction (TiDB has no triggers)
-- and checkable against it at any time. Stock is held at item level for items
-- tracked by quantity, at batch level for items tracked by batch. Every stock
-- row points at cf_item_details, so a definition can never be stocked.

-- ----- 12a. Stocking areas — each one holds an inventory ----------------------
-- purpose decides what its stock counts as: storage = available to use,
-- wip = in process (e.g. beside a machine), quarantine = held, dispatch =
-- finished and waiting to leave.
CREATE TABLE IF NOT EXISTS cf_stocking_areas (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  code         VARCHAR(50)   NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  purpose      ENUM('storage','wip','quarantine','dispatch') NOT NULL DEFAULT 'storage',
  machine_id   INT           NULL,               -- a WIP area that belongs to a machine
  status       ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes        TEXT          NULL,

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  code_active  VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_csar_tenant (company_id, id),
  UNIQUE KEY uq_csar_code   (company_id, code_active),

  CONSTRAINT fk_csar_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csar_machine FOREIGN KEY (company_id, machine_id) REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_csar_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 12b. Batches ------------------------------------------------------------
-- One delivery lot of a batch-tracked item (a heat of plate). Batch-level
-- specifications (HEAT_NO) are values on the batch — cf_spec_values with
-- subject_type 'batch' — required ones before the receipt can post. The code is
-- typed or comes from a coding rule; it is NULL only inside the transaction
-- that creates the batch.
CREATE TABLE IF NOT EXISTS cf_stock_batches (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  item_id       INT           NOT NULL,
  code          VARCHAR(60)   NULL,
  status        ENUM('available','on_hold','rejected') NOT NULL DEFAULT 'available',
  status_note   VARCHAR(255)  NULL,
  received_on   DATE          NULL,
  supplier_id   INT           NULL,
  supplier_ref  VARCHAR(100)  NULL,               -- the supplier's own lot or batch number
  notes         TEXT          NULL,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  code_active   VARCHAR(60)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_csb_tenant (company_id, id),
  UNIQUE KEY uq_csb_code   (company_id, code_active),
  KEY idx_csb_item (company_id, item_id),

  CONSTRAINT fk_csb_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csb_item     FOREIGN KEY (company_id, item_id)     REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_csb_supplier FOREIGN KEY (company_id, supplier_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_csb_creator  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 12c. Movements — the document behind ledger rows -----------------------
-- Posted when saved and never changed. A mistake is undone by a reversal: a new
-- movement with the opposite rows, linked both ways.
CREATE TABLE IF NOT EXISTS cf_stock_movements (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  code            VARCHAR(60)   NULL,             -- NULL only inside the transaction that posts it
  movement_type   ENUM('receipt','issue','transfer','adjustment','scrap','return') NOT NULL,
  movement_date   DATE          NOT NULL,
  party_id        INT           NULL,             -- the supplier on a receipt
  order_id        INT           NULL,             -- the sales order an issue is for
  reference       VARCHAR(100)  NULL,             -- delivery note, invoice, purchase order
  reason          VARCHAR(255)  NULL,             -- why: count, damage, reversal
  reversal_of_id  INT           NULL,
  reversed_by_id  INT           NULL,
  notes           TEXT          NULL,

  deleted_at      DATETIME      DEFAULT NULL,     -- never set: the ledger is not deleted
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  code_active     VARCHAR(60)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_csm_tenant (company_id, id),
  UNIQUE KEY uq_csm_code   (company_id, code_active),
  KEY idx_csm_date (company_id, movement_date),

  CONSTRAINT fk_csm_company     FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csm_party       FOREIGN KEY (company_id, party_id)       REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_csm_order       FOREIGN KEY (company_id, order_id)       REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_csm_reversal_of FOREIGN KEY (company_id, reversal_of_id) REFERENCES cf_stock_movements(company_id, id),
  CONSTRAINT fk_csm_reversed_by FOREIGN KEY (company_id, reversed_by_id) REFERENCES cf_stock_movements(company_id, id),
  CONSTRAINT fk_csm_creator     FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 12d. The ledger ---------------------------------------------------------
-- One row per stocking area a movement line touches: a transfer writes two
-- (- from, + to) under the same line_no; a receipt, issue, scrap or count one.
-- quantity is in the item's unit (one stock unit per item, decision I2).
CREATE TABLE IF NOT EXISTS cf_stock_ledger (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  movement_id       INT            NOT NULL,
  line_no           INT            NOT NULL,
  stocking_area_id  INT            NOT NULL,
  item_id           INT            NOT NULL,
  batch_id          INT            NULL,          -- set exactly when the item is tracked by batch
  quantity          DECIMAL(18,6)  NOT NULL,      -- + into the area, - out of it
  notes             VARCHAR(255)   NULL,

  deleted_at        DATETIME       DEFAULT NULL,  -- never set
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  UNIQUE KEY uq_csl_tenant (company_id, id),
  KEY idx_csl_movement (company_id, movement_id, line_no),
  KEY idx_csl_stock    (company_id, stocking_area_id, item_id, batch_id),
  KEY idx_csl_item     (company_id, item_id),
  KEY idx_csl_batch    (company_id, batch_id),

  CONSTRAINT fk_csl_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csl_movement FOREIGN KEY (company_id, movement_id)      REFERENCES cf_stock_movements(company_id, id),
  CONSTRAINT fk_csl_area     FOREIGN KEY (company_id, stocking_area_id) REFERENCES cf_stocking_areas(company_id, id),
  CONSTRAINT fk_csl_item     FOREIGN KEY (company_id, item_id)          REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_csl_batch    FOREIGN KEY (company_id, batch_id)         REFERENCES cf_stock_batches(company_id, id),
  CONSTRAINT fk_csl_creator  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 12e. Balances — what each stocking area holds now ------------------------
-- A cache of SUM(ledger.quantity) per area, item and batch; never negative (the
-- service refuses a movement that would make it so). Rows that fall to zero
-- stay, so "it was here" remains answerable; lists hide them.
CREATE TABLE IF NOT EXISTS cf_stock_balances (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  stocking_area_id  INT            NOT NULL,
  item_id           INT            NOT NULL,
  batch_id          INT            NULL,
  quantity          DECIMAL(18,6)  NOT NULL DEFAULT 0,
  last_movement_id  INT            NULL,

  deleted_at        DATETIME       DEFAULT NULL,  -- never set
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  batch_key         INT            GENERATED ALWAYS AS (IFNULL(batch_id, 0)) VIRTUAL,

  UNIQUE KEY uq_csk_tenant (company_id, id),
  UNIQUE KEY uq_csk_stock  (company_id, stocking_area_id, item_id, batch_key),
  KEY idx_csk_item  (company_id, item_id),
  KEY idx_csk_batch (company_id, batch_id),

  CONSTRAINT fk_csk_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csk_area     FOREIGN KEY (company_id, stocking_area_id) REFERENCES cf_stocking_areas(company_id, id),
  CONSTRAINT fk_csk_item     FOREIGN KEY (company_id, item_id)          REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_csk_batch    FOREIGN KEY (company_id, batch_id)         REFERENCES cf_stock_batches(company_id, id),
  CONSTRAINT fk_csk_movement FOREIGN KEY (company_id, last_movement_id) REFERENCES cf_stock_movements(company_id, id)
);


-- ============================================================================
-- 13. Release and the production tracker (decided 2026-09-22: release the
--     WHOLE sales line — E1; a step may not start until its material is
--     reserved — material gating on)
-- ============================================================================
-- Release turns one sales line's structure into execution records at once:
-- the tracker tree of production items (T1 = (c): one node per physical piece
-- for anything that has parts of its own, identical parts grouped under their
-- parent), their steps (from each piece's flow), the dependencies between steps
-- (flow order, Wait-For rules resolved on the tree, and the default that a
-- parent's first step waits for a child it names no step of), and the material
-- each step consumes. The tracker is the release snapshot: nothing here follows
-- later edits of the BOM or the flows.

-- ----- 13a. Releases — one per released sales line ------------------------------
CREATE TABLE IF NOT EXISTS cf_production_releases (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_id        INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  item_id         INT            NOT NULL,          -- what the line sells, at release
  item_revision   VARCHAR(20)    NULL,
  quantity        DECIMAL(18,6)  NOT NULL,          -- the line's quantity at release
  notes           TEXT           NULL,

  deleted_at      DATETIME       DEFAULT NULL,      -- set only by an unrelease: nothing started, nothing issued
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  line_live       INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, order_line_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_cprl_tenant (company_id, id),
  UNIQUE KEY uq_cprl_line   (company_id, line_live),
  KEY idx_cprl_order (company_id, order_id),

  CONSTRAINT fk_cprl_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cprl_order   FOREIGN KEY (company_id, order_id)      REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_cprl_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cprl_item    FOREIGN KEY (company_id, item_id)       REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cprl_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 13b. Production items — the tracker tree ---------------------------------
-- A made piece is a temporary item, or a catalog item that has a flow. A piece
-- with made parts of its own is one node per physical piece (piece_no 1…n,
-- numbered physically across the release: girder 1's segments are 1–4, girder
-- 2's 5–8); a piece without is one grouped node under its parent, quantity =
-- how many ("6 off"). Catalog items without a flow are material (13e), not nodes.
CREATE TABLE IF NOT EXISTS cf_production_items (
  id             INT            AUTO_INCREMENT PRIMARY KEY,
  company_id     INT            NOT NULL,
  release_id     INT            NOT NULL,
  parent_id      INT            NULL,
  item_id        INT            NOT NULL,
  bom_line_id    INT            NULL,              -- the BOM line it came from; NULL for what the sales line sells
  piece_no       INT            NULL,              -- a piece's physical number within the release; NULL for grouped parts
  quantity       DECIMAL(18,6)  NOT NULL,          -- 1 for a piece; the count for grouped parts
  code           VARCHAR(150)   NULL,              -- a piece's own code (P001-G01-1); grouped parts show their item's code
  flow_id        INT            NOT NULL,          -- how it is made, as it was at release
  flow_revision  VARCHAR(20)    NULL,
  depth          INT            NOT NULL,
  sort_order     INT            NOT NULL,

  deleted_at     DATETIME       DEFAULT NULL,
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT            NULL,

  UNIQUE KEY uq_cpri_tenant (company_id, id),
  KEY idx_cpri_release (company_id, release_id, sort_order),
  KEY idx_cpri_parent  (company_id, parent_id),
  KEY idx_cpri_item    (company_id, item_id),

  CONSTRAINT fk_cpri_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpri_release FOREIGN KEY (company_id, release_id)  REFERENCES cf_production_releases(company_id, id),
  CONSTRAINT fk_cpri_parent  FOREIGN KEY (company_id, parent_id)   REFERENCES cf_production_items(company_id, id),
  CONSTRAINT fk_cpri_item    FOREIGN KEY (company_id, item_id)     REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cpri_line    FOREIGN KEY (company_id, bom_line_id) REFERENCES cf_bom_lines(company_id, id),
  CONSTRAINT fk_cpri_flow    FOREIGN KEY (company_id, flow_id)     REFERENCES cf_operation_flows(company_id, id),
  CONSTRAINT fk_cpri_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 13c. Production steps — a piece's flow, copied at release -----------------
-- state is what people recorded; whether a pending step is READY is worked out
-- from its dependencies and its material, never stored. A step is done when its
-- good quantity reaches its quantity — scrapped pieces are made again (E2 in v1:
-- the pieces of one node move through a step together).
CREATE TABLE IF NOT EXISTS cf_production_steps (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  company_id          INT            NOT NULL,
  production_item_id  INT            NOT NULL,
  flow_step_id        INT            NULL,
  operation_id        INT            NOT NULL,
  sequence            INT            NOT NULL,
  step_name           VARCHAR(100)   NULL,
  quantity            DECIMAL(18,6)  NOT NULL,
  state               ENUM('pending','in_progress','done','on_hold') NOT NULL DEFAULT 'pending',
  held_from           ENUM('pending','in_progress') NULL,   -- the state a resume returns to
  qty_good            DECIMAL(18,6)  NOT NULL DEFAULT 0,
  qty_scrap           DECIMAL(18,6)  NOT NULL DEFAULT 0,
  machine_id          INT            NULL,
  started_at          DATETIME       NULL,
  finished_at         DATETIME       NULL,

  deleted_at          DATETIME       DEFAULT NULL,
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT            NULL,

  UNIQUE KEY uq_cprs_tenant (company_id, id),
  KEY idx_cprs_item      (company_id, production_item_id, sequence),
  KEY idx_cprs_state     (company_id, state),
  KEY idx_cprs_operation (company_id, operation_id),

  CONSTRAINT fk_cprs_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cprs_item      FOREIGN KEY (company_id, production_item_id) REFERENCES cf_production_items(company_id, id),
  CONSTRAINT fk_cprs_flow_step FOREIGN KEY (company_id, flow_step_id)       REFERENCES cf_operation_flow_steps(company_id, id),
  CONSTRAINT fk_cprs_operation FOREIGN KEY (company_id, operation_id)       REFERENCES cf_operations(company_id, id),
  CONSTRAINT fk_cprs_machine   FOREIGN KEY (company_id, machine_id)         REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_cprs_creator   FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 13d. Dependencies — who waits for whom, resolved at release --------------
-- origin  flow     the step waits for every step of the previous sequence
--                  number in its own flow (steps with equal numbers run alongside)
--         rule     a Wait-For rule of its flow step, resolved on the tree
--         default  a parent's first step waits for a child to be complete,
--                  unless one of the parent's own rules named a step of that child
-- The target is a step (required started | done) or a whole piece (complete).
CREATE TABLE IF NOT EXISTS cf_step_dependencies (
  id              INT        AUTO_INCREMENT PRIMARY KEY,
  company_id      INT        NOT NULL,
  step_id         INT        NOT NULL,
  target_step_id  INT        NULL,
  target_item_id  INT        NULL,
  required        ENUM('started','done','complete') NOT NULL,
  origin          ENUM('flow','rule','default','nest') NOT NULL,
  wait_rule_id    INT        NULL,

  deleted_at      DATETIME   DEFAULT NULL,
  created_at      TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT        NULL,

  UNIQUE KEY uq_csdp_tenant (company_id, id),
  KEY idx_csdp_step        (company_id, step_id),
  KEY idx_csdp_target_step (company_id, target_step_id),
  KEY idx_csdp_target_item (company_id, target_item_id),

  CONSTRAINT fk_csdp_company     FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csdp_step        FOREIGN KEY (company_id, step_id)        REFERENCES cf_production_steps(company_id, id),
  CONSTRAINT fk_csdp_target_step FOREIGN KEY (company_id, target_step_id) REFERENCES cf_production_steps(company_id, id),
  CONSTRAINT fk_csdp_target_item FOREIGN KEY (company_id, target_item_id) REFERENCES cf_production_items(company_id, id),
  CONSTRAINT fk_csdp_rule        FOREIGN KEY (company_id, wait_rule_id)   REFERENCES cf_step_wait_rules(company_id, id),
  CONSTRAINT fk_csdp_creator     FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 13e. Material requirements — what a step consumes -------------------------
-- A catalog item without a flow is bought or taken from stock: every such BOM
-- line under a made piece becomes a requirement on the step that consumes it —
-- the piece's first step for now. Material gating (decided 2026-09-22): that
-- step is not ready until the requirement is covered by reservations and
-- issues. A line that sells a bought item outright has one requirement with no
-- step: what must be there before it can be delivered.
CREATE TABLE IF NOT EXISTS cf_material_requirements (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  company_id          INT            NOT NULL,
  release_id          INT            NOT NULL,
  production_item_id  INT            NULL,
  step_id             INT            NULL,
  item_id             INT            NOT NULL,
  bom_line_id         INT            NULL,
  quantity            DECIMAL(18,6)  NOT NULL,
  issued              DECIMAL(18,6)  NOT NULL DEFAULT 0,

  deleted_at          DATETIME       DEFAULT NULL,
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT            NULL,

  UNIQUE KEY uq_cmrq_tenant (company_id, id),
  KEY idx_cmrq_release (company_id, release_id),
  KEY idx_cmrq_step    (company_id, step_id),
  KEY idx_cmrq_item    (company_id, item_id),

  CONSTRAINT fk_cmrq_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cmrq_release FOREIGN KEY (company_id, release_id)         REFERENCES cf_production_releases(company_id, id),
  CONSTRAINT fk_cmrq_piece   FOREIGN KEY (company_id, production_item_id) REFERENCES cf_production_items(company_id, id),
  CONSTRAINT fk_cmrq_step    FOREIGN KEY (company_id, step_id)            REFERENCES cf_production_steps(company_id, id),
  CONSTRAINT fk_cmrq_item    FOREIGN KEY (company_id, item_id)            REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cmrq_line    FOREIGN KEY (company_id, bom_line_id)        REFERENCES cf_bom_lines(company_id, id),
  CONSTRAINT fk_cmrq_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 13f. Reservations — stock set aside for a requirement ----------------------
-- A claim, not a place: it names the item (and the batch, for an item kept by
-- batch) but no stocking area, so moving the stock between usable areas keeps
-- it. What is free = available on hand (storage and WIP areas, batch not held)
-- minus active reservations; issues, scrap and moves into quarantine that would
-- eat into reserved stock are refused. quantity falls as the stock is issued to
-- the requirement; at zero the reservation is consumed.
CREATE TABLE IF NOT EXISTS cf_stock_reservations (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  requirement_id  INT            NOT NULL,
  item_id         INT            NOT NULL,
  batch_id        INT            NULL,              -- set exactly when the item is kept by batch
  quantity        DECIMAL(18,6)  NOT NULL,
  status          ENUM('active','released','consumed') NOT NULL DEFAULT 'active',
  closed_at       DATETIME       NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  UNIQUE KEY uq_csrv_tenant (company_id, id),
  KEY idx_csrv_stock       (company_id, item_id, batch_id, status),
  KEY idx_csrv_requirement (company_id, requirement_id, status),

  CONSTRAINT fk_csrv_company     FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csrv_requirement FOREIGN KEY (company_id, requirement_id) REFERENCES cf_material_requirements(company_id, id),
  CONSTRAINT fk_csrv_item        FOREIGN KEY (company_id, item_id)        REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_csrv_batch       FOREIGN KEY (company_id, batch_id)       REFERENCES cf_stock_batches(company_id, id),
  CONSTRAINT fk_csrv_creator     FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ----- 13g. Step events — what was recorded on the shop floor, never edited -------
CREATE TABLE IF NOT EXISTS cf_step_events (
  id           INT            AUTO_INCREMENT PRIMARY KEY,
  company_id   INT            NOT NULL,
  step_id      INT            NOT NULL,
  event        ENUM('start','progress','hold','resume') NOT NULL,
  qty_good     DECIMAL(18,6)  NOT NULL DEFAULT 0,
  qty_scrap    DECIMAL(18,6)  NOT NULL DEFAULT 0,
  machine_id   INT            NULL,
  note         VARCHAR(500)   NULL,

  deleted_at   DATETIME       DEFAULT NULL,        -- never set: the history is append-only
  created_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT            NULL,

  UNIQUE KEY uq_csev_tenant (company_id, id),
  KEY idx_csev_step (company_id, step_id, id),

  CONSTRAINT fk_csev_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csev_step    FOREIGN KEY (company_id, step_id)    REFERENCES cf_production_steps(company_id, id),
  CONSTRAINT fk_csev_machine FOREIGN KEY (company_id, machine_id) REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_csev_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 13b. Columns added to earlier tables ----------------------------------------
-- Where a catalog item comes from (user, 2026-09-23). Guarded, so the file stays
-- safe to re-run on a database created before it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'sourcing');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_item_details ADD COLUMN sourcing ENUM('stock','make','both') NOT NULL DEFAULT 'stock' AFTER uom",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
-- A temporary item exists only to be made on its order; it is never stocked.
UPDATE cf_item_details SET sourcing = 'make' WHERE item_type = 'temporary' AND sourcing <> 'make';


-- ===== 14. BUYING — what is short, asked for and received ====================
-- The FAB ERP shape, narrowed to CF's model: this is NOT MRP. Nothing here
-- plans or explodes anything. The demand is what open releases already ask for
-- and do not have (cf_material_requirements minus what is issued, reserved,
-- free in stock and already on order), and a purchase order is the document
-- that records the answer.
--
-- One line per item per order: two lines of the same plate on one order is a
-- clerical accident, and netting what is on order needs one row to add up.

CREATE TABLE IF NOT EXISTS cf_purchase_orders (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  company_id     INT           NOT NULL,
  -- NULL for the instant between the insert and the number being stamped: with
  -- no coding rule for purchase orders the fallback number is PO-000123, which
  -- needs the row's own id. Never NULL once the transaction ends.
  code           VARCHAR(100)  NULL,
  supplier_id    INT           NULL,            -- chosen when it is sent, not when it is raised
  status         ENUM('draft','ordered','partially_received','received','cancelled') NOT NULL DEFAULT 'draft',
  suggested      TINYINT(1)    NOT NULL DEFAULT 0,  -- raised by "suggest what to buy"; rewritten in place
  expected_date  DATE          NULL,
  ordered_at     DATETIME      NULL,
  notes          TEXT          NULL,

  deleted_at     DATETIME      DEFAULT NULL,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT           NULL,

  code_active    VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  -- At most one open suggested order per company: running the suggestion again
  -- rewrites it rather than buying the steel twice.
  suggest_live   TINYINT(1)    GENERATED ALWAYS AS (IF(deleted_at IS NULL AND suggested = 1 AND status = 'draft', 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cpo_tenant  (company_id, id),
  UNIQUE KEY uq_cpo_code    (company_id, code_active),
  UNIQUE KEY uq_cpo_suggest (company_id, suggest_live),
  KEY idx_cpo_status   (company_id, status),
  KEY idx_cpo_supplier (company_id, supplier_id),

  CONSTRAINT fk_cpo_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpo_supplier FOREIGN KEY (company_id, supplier_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_cpo_creator  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_purchase_order_lines (
  id                 INT            AUTO_INCREMENT PRIMARY KEY,
  company_id         INT            NOT NULL,
  purchase_order_id  INT            NOT NULL,
  line_no            INT            NOT NULL,
  item_id            INT            NOT NULL,
  quantity           DECIMAL(18,6)  NOT NULL,
  qty_received       DECIMAL(18,6)  NOT NULL DEFAULT 0,
  uom                VARCHAR(20)    NOT NULL DEFAULT 'nos',
  expected_date      DATE           NULL,
  note               VARCHAR(500)   NULL,

  deleted_at         DATETIME       DEFAULT NULL,
  created_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  item_live          INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, item_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_cpol_tenant (company_id, id),
  UNIQUE KEY uq_cpol_item   (purchase_order_id, item_live),
  KEY idx_cpol_order (company_id, purchase_order_id, line_no),
  KEY idx_cpol_item  (company_id, item_id),

  CONSTRAINT fk_cpol_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpol_order   FOREIGN KEY (company_id, purchase_order_id) REFERENCES cf_purchase_orders(company_id, id),
  CONSTRAINT fk_cpol_item    FOREIGN KEY (company_id, item_id) REFERENCES cf_item_details(company_id, master_id)
);

-- Which purchase line a receipt came in against, so "ordered / received /
-- outstanding" is the movement's own history and not a running total nobody
-- can check. NULL on every receipt with no purchase order behind it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND COLUMN_NAME = 'purchase_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_movements ADD COLUMN purchase_line_id INT NULL AFTER order_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND CONSTRAINT_NAME = 'fk_csm_purchase_line');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_stock_movements ADD CONSTRAINT fk_csm_purchase_line FOREIGN KEY (company_id, purchase_line_id) REFERENCES cf_purchase_order_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 15. FINISHED WORK BECOMES STOCK =======================================
-- Idea A (user, 2026-09-23): "Once it enters as the done stock for the line item
-- in the order, it is ready to be shipped." When the piece a line sells finishes
-- its last step, the good quantity is RECEIVED into a finished-goods area and
-- earmarked for that line; shipping is an ordinary issue against the order,
-- which consumes the earmark. Counted as a quantity for now — unit by unit,
-- with a piece number of its own, is a phase of its own.

-- Where a release's finished work goes. NULL falls back to the one active
-- dispatch area; with none, or several, release asks for it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_releases' AND COLUMN_NAME = 'finished_area_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_production_releases ADD COLUMN finished_area_id INT NULL AFTER quantity', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_releases' AND CONSTRAINT_NAME = 'fk_cprl_finished_area');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_production_releases ADD CONSTRAINT fk_cprl_finished_area FOREIGN KEY (company_id, finished_area_id) REFERENCES cf_stocking_areas(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A reservation now claims stock for ONE of two things: material a step needs
-- (requirement_id), or finished work owed to a sales line (order_line_id).
-- Exactly one is set; the service enforces it (TiDB has no CHECK).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND COLUMN_NAME = 'order_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_reservations ADD COLUMN order_line_id INT NULL AFTER requirement_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @null = (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND COLUMN_NAME = 'requirement_id' AND IS_NULLABLE = 'NO');
SET @sql = IF(@null = 1, 'ALTER TABLE cf_stock_reservations MODIFY COLUMN requirement_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND CONSTRAINT_NAME = 'fk_csrv_order_line');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_stock_reservations ADD CONSTRAINT fk_csrv_order_line FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- How much of a line has been made, and how much has left the yard.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'made_qty');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_order_lines ADD COLUMN made_qty DECIMAL(18,6) NOT NULL DEFAULT 0 AFTER quantity', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'delivered_qty');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_order_lines ADD COLUMN delivered_qty DECIMAL(18,6) NOT NULL DEFAULT 0 AFTER made_qty', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Which sales line a shipment was for (an issue already carries its order).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND COLUMN_NAME = 'order_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_movements ADD COLUMN order_line_id INT NULL AFTER order_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND CONSTRAINT_NAME = 'fk_csm_order_line');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_stock_movements ADD CONSTRAINT fk_csm_order_line FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- What a tracker piece has already put into stock, so a completed piece is
-- never received twice.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_items' AND COLUMN_NAME = 'stocked_qty');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_production_items ADD COLUMN stocked_qty DECIMAL(18,6) NOT NULL DEFAULT 0 AFTER quantity', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 16. IDENTITY FOR WHAT IS MADE AND WHAT IS STOCKED =====================
-- "Stock and WIP should all get a code to identify at every level, driven
-- through the code generator" (user, 2026-09-23). A tracker piece is the WIP
-- thing and already has a `code` column — it is now filled for EVERY node, by
-- the generator. A lot of stock is a batch, and production's own output makes
-- one, so the finished thing on the shelf is identifiable and traceable back to
-- the piece that made it.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND COLUMN_NAME = 'production_item_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_batches ADD COLUMN production_item_id INT NULL AFTER supplier_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND CONSTRAINT_NAME = 'fk_csb_production_item');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_stock_batches ADD CONSTRAINT fk_csb_production_item FOREIGN KEY (company_id, production_item_id) REFERENCES cf_production_items(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 17. A SHORT NAME TO BUILD CODES FROM ==================================
-- "WEB", "FLG", "GIRD" — a few characters that stand for the thing, so the codes
-- generated for stock and WIP read as what they are instead of as a number.
-- Deliberately not `code`: a code is the record's own identity and is fixed once
-- the record is active, while a short name is only an ingredient the generator
-- reaches for, so it stays editable for the life of the record.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_master_records' AND COLUMN_NAME = 'short_name');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_master_records ADD COLUMN short_name VARCHAR(30) NULL AFTER name', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 18. THE PROCESS — HOW AN ORDER IS WORKED ==============================
-- Decided with the user 2026-09-23/24. A PROCESS is how an order is worked
-- through the office: an ordered list of stages. It is deliberately not called
-- a flow — a flow already means how a girder is MADE (cut, weld, paint), and
-- the two would be confused daily.
--
-- What is code and what is data (fab_erp argued this out first): the KINDS of
-- stage are code, because a stage is a screen somebody wrote and no amount of
-- configuration conjures one nobody did. What varies — which stages a customer
-- wants, in what order, and whether a stage applies to a particular line — is
-- data, and lives here.
--
-- Stage ORDER is fixed per process (user, decision 1): you arrange the stages
-- when you define the process, and an order follows what it was given. Order
-- encodes real dependencies — you cannot buy a plate nobody has chosen yet.

CREATE TABLE IF NOT EXISTS cf_processes (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  code         VARCHAR(50)   NOT NULL,
  name         VARCHAR(200)  NOT NULL,
  description  TEXT          NULL,
  status       ENUM('draft','active','obsolete') NOT NULL DEFAULT 'draft',

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  code_active  VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cpr_tenant (company_id, id),
  UNIQUE KEY uq_cpr_code   (company_id, code_active),
  KEY idx_cpr_status (company_id, status),

  CONSTRAINT fk_cpr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpr_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- The stages of one process, in the order they are worked.
--
-- `stage_key` names a kind from the catalogue in services/processService.js.
-- It is NOT a foreign key: the catalogue of kinds lives in code, because each
-- kind IS code.
--
-- `override_spec_id` is how a line says this stage does not apply to it (user:
-- "have a specification on the line item that can be used for this"). The
-- specification resolves most-specific-wins like every other, so an item's own
-- answer beats the customer's default (decision 3) with no rule of its own.
-- Left NULL, the stage is worked out from the data alone (decision 2).
CREATE TABLE IF NOT EXISTS cf_process_stages (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  process_id       INT           NOT NULL,
  stage_key        VARCHAR(30)   NOT NULL,
  sequence         INT           NOT NULL,
  label            VARCHAR(100)  NULL,          -- overrides the kind's own name
  requirement      ENUM('required','optional') NOT NULL DEFAULT 'required',
  override_spec_id INT           NULL,
  settings         JSON          NULL,          -- what the stage's screen is configured with

  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  seq_live         INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, sequence, NULL)) VIRTUAL,

  UNIQUE KEY uq_cps_tenant (company_id, id),
  UNIQUE KEY uq_cps_seq    (process_id, seq_live),
  KEY idx_cps_process (company_id, process_id, sequence),

  CONSTRAINT fk_cps_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cps_process FOREIGN KEY (company_id, process_id)       REFERENCES cf_processes(company_id, id),
  CONSTRAINT fk_cps_spec    FOREIGN KEY (company_id, override_spec_id) REFERENCES cf_specifications(company_id, id)
);

-- When a process applies. Most specific wins (decision 3): a rule naming both
-- the customer and the order type beats one naming only the customer, which
-- beats one naming only the type, which beats the house default (both NULL).
CREATE TABLE IF NOT EXISTS cf_process_rules (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  process_id   INT           NOT NULL,
  customer_id  INT           NULL,              -- NULL = any customer
  order_type   ENUM('customer','stock') NULL,   -- NULL = any kind of order

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  match_live   VARCHAR(40)   GENERATED ALWAYS AS
    (IF(deleted_at IS NULL, CONCAT(IFNULL(customer_id, 'any'), ':', IFNULL(order_type, 'any')), NULL)) VIRTUAL,

  UNIQUE KEY uq_cprr_tenant (company_id, id),
  UNIQUE KEY uq_cprr_match  (company_id, match_live),
  KEY idx_cprr_process (company_id, process_id),

  CONSTRAINT fk_cprr_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cprr_process  FOREIGN KEY (company_id, process_id)  REFERENCES cf_processes(company_id, id),
  CONSTRAINT fk_cprr_customer FOREIGN KEY (company_id, customer_id) REFERENCES cf_parties(company_id, id)
);

-- The process an order is following. Stamped when the order is created, so
-- changing a customer's process later does not move orders already running.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND COLUMN_NAME = 'process_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_orders ADD COLUMN process_id INT NULL AFTER order_type', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND CONSTRAINT_NAME = 'fk_csor_process');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_sales_orders ADD CONSTRAINT fk_csor_process FOREIGN KEY (company_id, process_id) REFERENCES cf_processes(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 19. A FLOW MAY REPEAT AN OPERATION ===================================
-- Retrofit for databases built before 2026-09-24, kept down here rather than
-- beside cf_operation_flow_steps (section 10c): an ALTER that sits above its
-- own CREATE aborts the whole file on a genuinely empty schema.
--
-- cf_operation_flow_steps was created with
--     UNIQUE KEY uq_cofs_operation (company_id, flow_id, operation_id, is_live)
-- which allowed an operation to appear only ONCE in a flow. Real work does not
-- obey that: a plate girder is welded on one side, crane-turned and welded on
-- the other — two steps of one operation (SAW Welding) with a Crane Turn
-- between them. Importing the real fab_erp flows, 43 steps collapsed to 27;
-- the two-pass weld, the second fit-up stage and every repeated crane move
-- were all refused. Calling them SAW-1 and SAW-2 would encode the sequence
-- into the operation's identity and break on the first three-pass job.
--
-- It is replaced, not simply dropped. uq_cofs_operation_seq adds `sequence`,
-- so an operation may repeat as often as the work needs but never twice at one
-- sequence number — and since steps that share a number run in parallel, that
-- is exactly the case where "the first pass" and "the last pass" would be
-- arbitrary. A Wait-For rule naming an operation depends on that order being
-- decided (services/flowService.js, services/releaseService.js).
--
-- Adding the new key cannot fail on existing data: the old key was strictly
-- stronger, so no live flow has two steps of one operation at all.
--
-- `is_live` stays on the table. Its only remaining reader is the new key, and
-- dropping a generated column that `SELECT s.*` still returns buys nothing.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_operation_flow_steps'
               AND INDEX_NAME = 'uq_cofs_operation');
SET @sql = IF(@idx > 0, 'ALTER TABLE cf_operation_flow_steps DROP INDEX uq_cofs_operation', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_operation_flow_steps'
               AND INDEX_NAME = 'uq_cofs_operation_seq');
SET @sql = IF(@idx = 0,
  'ALTER TABLE cf_operation_flow_steps ADD UNIQUE KEY uq_cofs_operation_seq (company_id, flow_id, operation_id, sequence, is_live)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ===== 20. DRAWINGS — the paper the job is built to ==========================
-- A fabrication job has drawings at every level: a general arrangement for the
-- span, an elevation for a girder line, a shop drawing for a segment, a part
-- detail, a nesting layout for a cut plate. Three facts about them decide the
-- whole shape of these two tables.
--
-- 1. ONE DRAWING COVERS MANY NODES. A GA covers the span and everything under
--    it; one shop drawing often covers six identical segments. So a drawing
--    cannot be a column on a node — it is its own record, joined to the nodes
--    it covers by cf_drawing_links.
--
-- 2. A DRAWING IS NOT A MASTER RECORD. cf_master_records.record_kind is
--    ENUM('item','definition'), and every one of the ~77 places that branch on
--    it is written `=== 'item'` with the else treating the row as a definition.
--    A third value would make a drawing read as a definition in every one of
--    those else branches — silently. The code generator does not require being
--    a master record either: machine, sales_order, stock_batch, purchase_order
--    and stock_lot are all registered entities and none of them is one.
--
-- 3. THERE IS NO FILE STORAGE IN THIS STACK, and choosing one is a separate
--    decision. So this is a REFERENCE — number, revision, and optionally a URL
--    where the file happens to live — never a file and never an upload.
--
-- ONE ROW PER REVISION — deliberately the opposite of decision Q2.
-- cf_master_records keeps ONE row and moves a `revision` label on it, because
-- every BOM line, production item and stock piece points at that row and would
-- otherwise have to be re-pointed the day Rev B arrives. A drawing link is the
-- exact opposite case: it exists to say WHICH revision a node was built to. If
-- the row carried a moving label, the answer to "which revision was this made
-- to?" would change retroactively every time a new sheet arrived — which is
-- the one question this whole app exists to answer. So a revision is a NEW
-- ROW, and a link always points at a specific revision.
--
-- The revision history is walked two ways, neither of them recursive:
--   root_id       every revision of one drawing shares it (the first row points
--                 at itself), so the whole history is ONE indexed read — this
--                 runs on TiDB, where a per-row round trip costs ~49 ms.
--   supersedes_id the row this one replaced, so the chain's order is a fact and
--                 not an assumption about ids. Unique while live: a revision
--                 can be superseded once, so the chain cannot fork.
--
-- `number` is the number as the ISSUER writes it — the KEPL BOQ arrived as
-- P103-VDB-WK-DD-MJB-200+003-401, which is the customer's numbering and obeys
-- none of our rules. `code` is OUR handle for the row, from the code generator
-- like every other code in this app (services/codegenProvider.js, entity
-- `drawing`). Two different things, two columns; `source` says whose numbering
-- `number` is in, and is part of its uniqueness because a customer and the shop
-- may each hold a sheet called "401".

CREATE TABLE IF NOT EXISTS cf_drawings (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  company_id     INT           NOT NULL,
  code           VARCHAR(100)  NULL,            -- ours, generated; NULL only between INSERT and the generator
  number         VARCHAR(150)  NOT NULL,        -- the issuer's, exactly as written
  revision       VARCHAR(20)   NOT NULL DEFAULT 'A',
  title          VARCHAR(255)  NULL,
  source         ENUM('customer','shop') NOT NULL DEFAULT 'shop',
  url            VARCHAR(1000) NULL,            -- where the file happens to live; no file is stored here
  status         ENUM('draft','issued','superseded','withdrawn') NOT NULL DEFAULT 'draft',
  issued_on      DATE          NULL,            -- so "what was current in August" is answerable
  notes          TEXT          NULL,

  root_id        INT           NULL,            -- the first revision; self on that first row
  supersedes_id  INT           NULL,            -- the revision this one replaced

  deleted_at     DATETIME      DEFAULT NULL,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT           NULL,

  code_active    VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  number_active  VARCHAR(150)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(number), NULL)) VIRTUAL,
  is_live        TINYINT       GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cdw_tenant     (company_id, id),
  UNIQUE KEY uq_cdw_code       (company_id, code_active),
  -- One row per issuer's number AND revision: "P103-…-401 Rev 3 from the
  -- customer" is one sheet and cannot be entered twice.
  UNIQUE KEY uq_cdw_number     (company_id, source, number_active, revision),
  UNIQUE KEY uq_cdw_supersedes (company_id, supersedes_id, is_live),
  KEY idx_cdw_root   (company_id, root_id),
  KEY idx_cdw_status (company_id, status),

  CONSTRAINT fk_cdw_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cdw_root       FOREIGN KEY (company_id, root_id)       REFERENCES cf_drawings(company_id, id),
  CONSTRAINT fk_cdw_supersedes FOREIGN KEY (company_id, supersedes_id) REFERENCES cf_drawings(company_id, id),
  CONSTRAINT fk_cdw_creator    FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 20a. Drawing links — what a drawing covers ---------------------------
-- The join that lets one drawing cover many nodes and one node carry many
-- drawings (a segment has a GA above it, its own shop drawing, and a nesting
-- layout for the plate it is cut from).
--
-- `subject_type` is an ENUM so it can grow — a drawing will eventually hang off
-- a sales order, an order line, a nest or a stock piece. Only 'master_record'
-- is implemented, because every level of a custom BOM already IS a master
-- record: the span, the girder line, the segment, the part and the cut plate
-- are all temporary items. Adding a value later is additive; nothing branches
-- on this column as "master_record or else".
--
-- Polymorphic, so no foreign key on subject_id (the same rule cf_spec_values
-- and cf_spec_assignments live by) — the service checks the subject exists in
-- this company before it writes.
--
-- A LINK IS NEVER MOVED. When a drawing is revised, its live links are COPIED
-- onto the new revision's row and the old ones are left exactly where they are.
-- Re-pointing them would answer "what covers this segment now?" correctly and
-- destroy "what was it built to in August?" — and the second question is the
-- one the traceability exists for. Leaving them and copying nothing would do
-- the reverse. Copying forward answers both: the old links stay true of a row
-- that is now `superseded`, and the new row carries the live coverage.

CREATE TABLE IF NOT EXISTS cf_drawing_links (
  id           INT        AUTO_INCREMENT PRIMARY KEY,
  company_id   INT        NOT NULL,
  drawing_id   INT        NOT NULL,             -- a specific REVISION, never "the drawing"
  subject_type ENUM('master_record') NOT NULL DEFAULT 'master_record',
  subject_id   INT        NOT NULL,
  note         VARCHAR(255) NULL,               -- "sheet 3 of 7", "sections B-B and C-C"

  deleted_at   DATETIME   DEFAULT NULL,
  created_at   TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT        NULL,

  is_live      TINYINT    GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cdl_tenant (company_id, id),
  UNIQUE KEY uq_cdl_pair   (company_id, drawing_id, subject_type, subject_id, is_live),
  KEY idx_cdl_subject (company_id, subject_type, subject_id),
  KEY idx_cdl_drawing (company_id, drawing_id),

  CONSTRAINT fk_cdl_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cdl_drawing FOREIGN KEY (company_id, drawing_id) REFERENCES cf_drawings(company_id, id),
  CONSTRAINT fk_cdl_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ===== 21. NESTING — the rectangles laid out on real plates ==================
-- cutPlateService pools a line's plate parts into CUT PLATES: rectangles of one
-- thickness/length/width/grade, each a temporary item of quantity N. The line
-- from a cut plate to its raw plate carries an AREA FRACTION, and
-- cutPlateService.AREA_FRACTION_CAVEAT says out loud what that is worth — it
-- ignores how the blanks lie on the sheet and the offcut left over. These three
-- tables are what replaces it with a real plate count.
--
-- THE MODEL IN ONE PARAGRAPH. A nest is a shared raw plate, not a document
-- (CF_ERP_PLAN §671–692). So there is no "nest" table: there is a LOT, one
-- physical plate drawn from stock once, and the cut plates that name the same
-- lot ARE that nest. A PLACEMENT is one piece of one cut plate sitting at one
-- (x, y) on one lot. Cut plates belong to a sales order line, so a lot does
-- too, and nesting is within a line.
--
-- QUANTITY SEMANTICS, STATED ONCE AND REPEATED IN nestingService.js: a
-- placement is ONE PIECE on ONE LOT. The plate count of a nest is always 1,
-- because a nest IS one lot. Count LOTS to count plates; SUM PLACEMENTS to
-- count pieces. Never sum placements to get plates — that is the arithmetic
-- that buys a plate per blank.

-- ----- 21a. Cut settings — kerf bands, sequence gaps, ordering margins ------
-- KERF IS BANDED BY PLATE THICKNESS, not set per exact thickness, because that
-- is how the shop quotes it:
--      5–16 mm -> 2.5–3 mm     18–20 mm -> 4 mm     25–50 mm -> 5 mm
-- so the row carries a RANGE (`thickness_min_mm` .. `thickness_max_mm`,
-- inclusive) and one kerf. Both NULL is the company default row, used when no
-- band covers a thickness.
--
-- THERE IS ONE KERF NUMBER AND TWO WAYS IT IS SPENT.
--   EDGE kerf   an unshared boundary. Charged once per side, and it IS charged
--               at the plate rim — the raw plate's own edge gets cut too.
--   COMMON kerf two parts sharing a boundary, which is cut ONCE.
-- One number, so both are `kerf_mm`. The arithmetic that follows: a row of n
-- parts that share their boundaries spans SUM(sizes) + (n + 1) * kerf. Three
-- 100 mm parts at 3 mm kerf span 312 mm sharing, 318 mm not sharing — the
-- shop's own worked example, and the reason a single resolver
-- (nestingService.resolveCutSettings) is used by the planner and by the
-- accept-time verification alike. Two constants in two places is the bug.
--
-- SEQUENCES. A plate is cut Plate -> Sequence -> Row -> Part: a sequence holds
-- a fixed number of rows and is cut as a unit, in order, so the pierce order is
-- controlled. Consecutive sequences are separated by `seq_gap_min_mm` ..
-- `seq_gap_max_mm` (5–8 mm).
--
-- ORDERING MARGIN. After kerf, sequences and shared boundaries give the exact
-- requirement, the plate is ORDERED larger — `order_margin_width_mm` (50) and
-- `order_margin_length_mm` (100) — because plate edges are not straight and a
-- standard size procures faster. That difference is deliberate and is NOT
-- waste, which is why cf_plate_lots records the required size and the ordered
-- size as two separate numbers.
--
-- The uniqueness key holds the BAND. `band_key` folds the default row onto the
-- sentinel -1 (no plate has a negative thickness) so a company can hold exactly
-- one default, which a plain NULL column could never enforce — MySQL never
-- compares NULLs in a unique index. It still goes NULL when the row is
-- soft-deleted, so it keeps the whole point of the `_active` pattern. Bands are
-- checked for overlap in the service; a unique key cannot express that.

CREATE TABLE IF NOT EXISTS cf_cut_settings (
  id                     INT            AUTO_INCREMENT PRIMARY KEY,
  company_id             INT            NOT NULL,
  thickness_min_mm       DECIMAL(10,3)  NULL,           -- inclusive; both NULL = the default row
  thickness_max_mm       DECIMAL(10,3)  NULL,           -- inclusive
  kerf_mm                DECIMAL(10,3)  NOT NULL DEFAULT 3.000,  -- per cut side; edge AND common
  seq_gap_min_mm         DECIMAL(10,3)  NOT NULL DEFAULT 5.000,
  seq_gap_max_mm         DECIMAL(10,3)  NOT NULL DEFAULT 8.000,
  order_margin_length_mm DECIMAL(10,3)  NOT NULL DEFAULT 100.000,
  order_margin_width_mm  DECIMAL(10,3)  NOT NULL DEFAULT 50.000,
  order_step_mm          DECIMAL(10,3)  NOT NULL DEFAULT 50.000,  -- ADD the margin, THEN round up to this
  guillotine             TINYINT(1)     NOT NULL DEFAULT 0,      -- 1 = shear/saw, 0 = CNC profile cutting
  notes                  VARCHAR(500)   NULL,

  deleted_at             DATETIME       DEFAULT NULL,
  created_at             TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by             INT            NULL,

  is_live   TINYINT       GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  band_key  VARCHAR(40)   GENERATED ALWAYS AS (IF(deleted_at IS NULL,
                            CONCAT(IFNULL(thickness_min_mm, -1), ':', IFNULL(thickness_max_mm, -1)), NULL)) VIRTUAL,

  UNIQUE KEY uq_ccst_tenant (company_id, id),
  UNIQUE KEY uq_ccst_band   (company_id, band_key),

  CONSTRAINT fk_ccst_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccst_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 21b. Plate lots — one physical raw plate consumed by a line ----------
-- `plate_item_id` is the CATALOG plate (Steel › Plates › Plate) this lot is one
-- of; the lot is the instance. Its size is COPIED onto the row rather than
-- joined for: a saved layout is verified against the sheet it was laid out on,
-- and somebody correcting a catalog plate's width next month must not silently
-- invalidate — or worse, silently validate — a plan already accepted.
--
-- TWO SIZES, ON PURPOSE.
--   required_length_mm / required_width_mm  what the layout actually needs,
--                                           kerf and sequence gaps included.
--   length_mm / width_mm                    the STOCKED PLATE this lot is,
--                                           and what the geometry is verified
--                                           against.
-- The shop ALWAYS BUYS A STOCKED SIZE (decided 2026-09-25), so length_mm IS
-- what is bought — there is no third "ordered" number and deliberately no
-- column for one, because a number nobody buys would be read as one somebody
-- does. The gap between the two is the spare on a stocked plate, not waste, and
-- quoting wastage against the plate without saying so makes every one of them
-- look worse than it is. The +50/+100 ordering margin is therefore ADVICE: the
-- only thing it can say is "no size you stock leaves the margin you want here".
--
-- The same reasoning puts kerf, the sequence gaps and guillotine here: they are
-- resolved from cf_cut_settings when the plan is accepted and RECORDED, so
-- re-opening a plan checks its geometry against the numbers it was built with
-- rather than against whatever the settings say today.
--
-- `source` = 'offcut' with `origin_lot_id` is how a drop re-enters the pool
-- (CF_ERP_PLAN: "the offcut is an unclaimed cut plate"). The columns are here
-- because the model needs them; today nestingService only ever proposes
-- 'catalog' lots, and offcut sourcing is a separate piece of work.
--
-- `is_manual` marks a lot a person laid out by hand rather than one the packer
-- produced — the screen and the Excel sheet can both write one.

CREATE TABLE IF NOT EXISTS cf_plate_lots (
  id                 INT            AUTO_INCREMENT PRIMARY KEY,
  company_id         INT            NOT NULL,
  order_line_id      INT            NOT NULL,
  plate_item_id      INT            NOT NULL,        -- the catalog plate this lot is one of
  lot_no             VARCHAR(30)    NOT NULL,        -- N-001, N-002 … unique within the line
  source             ENUM('catalog','offcut') NOT NULL DEFAULT 'catalog',
  origin_lot_id      INT            NULL,            -- the lot an offcut was left over from

  thickness_mm       DECIMAL(10,3)  NOT NULL,
  length_mm          DECIMAL(12,3)  NOT NULL,        -- ORDERED size; the geometry is verified against it
  width_mm           DECIMAL(12,3)  NOT NULL,        -- ORDERED size
  required_length_mm DECIMAL(12,3)  NULL,            -- what the layout needs, kerf and gaps included
  required_width_mm  DECIMAL(12,3)  NULL,
  grade              VARCHAR(100)   NULL,            -- as resolved when the plan was accepted
  material           VARCHAR(100)   NULL,
  density            DECIMAL(12,3)  NULL,            -- kg/m3, so wastage can be quoted in kg

  kerf_mm            DECIMAL(10,3)  NOT NULL DEFAULT 0.000,
  seq_gap_min_mm     DECIMAL(10,3)  NOT NULL DEFAULT 0.000,
  seq_gap_max_mm     DECIMAL(10,3)  NOT NULL DEFAULT 0.000,
  guillotine         TINYINT(1)     NOT NULL DEFAULT 0,
  is_manual          TINYINT(1)     NOT NULL DEFAULT 0,
  notes              VARCHAR(500)   NULL,

  deleted_at         DATETIME       DEFAULT NULL,
  created_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT            NULL,

  is_live       TINYINT     GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  lot_no_active VARCHAR(30) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(lot_no), NULL)) VIRTUAL,

  UNIQUE KEY uq_cpl_tenant (company_id, id),
  UNIQUE KEY uq_cpl_lot_no (company_id, order_line_id, lot_no_active),
  KEY idx_cpl_line  (company_id, order_line_id),
  KEY idx_cpl_plate (company_id, plate_item_id),

  CONSTRAINT fk_cpl_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpl_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cpl_plate   FOREIGN KEY (company_id, plate_item_id) REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cpl_origin  FOREIGN KEY (company_id, origin_lot_id) REFERENCES cf_plate_lots(company_id, id),
  CONSTRAINT fk_cpl_creator FOREIGN KEY (created_by) REFERENCES users(id)
);


-- ----- 21c. Nest placements — where one piece sits on one lot ---------------
-- ONE ROW IS ONE PIECE. A cut plate of quantity 6 that fits on one lot is SIX
-- rows on that lot, not one row with a quantity, because each piece has its own
-- position and the screen draws it. That is also why there is no quantity
-- column: a quantity here is the shape of the bug this table exists to avoid.
--
-- A PLACEMENT IS INSIDE A SEQUENCE AND A ROW, NOT FREE x/y. The layout is
-- Plate -> Sequence -> Row -> Part, and the CUT ORDER IS THE POINT: sequence 1
-- is cut in full, then sequence 2, then 3, so the pierce order is controlled
-- and the plate does not distort. `idx_cnp_cut_order` exists so that
-- "this lot's layout in cut order" is an index-ordered read and nobody has to
-- remember to sort it.
--   seq_no  the sequence on the plate, 1-based, cut as a unit and in order
--   row_no  the row within that sequence, 1-based
--   pos_no  the part's place along that row, 1-based
-- How many rows a sequence holds is set by PART SIZE ON BOTH DIMENSIONS:
-- under 200 mm on both is Small and the sequence holds 2 rows; anything larger
-- is Big and it holds 3. That rule lives in nestingService (rowsPerSequence)
-- because it is arithmetic, not storage — the table records what was decided.
--
-- x/y remain, and are the TRUE corner of the piece on the sheet measured from
-- the sheet's own corner, so the screen can draw the plate without re-deriving
-- the layout from the sequence and row numbers.
--
-- `length_mm`/`width_mm` are the footprint AS PLACED (already swapped when
-- `rotated`), so verification and drawing both read the row rather than
-- recombining it with the cut plate's size and a flag.
--
-- KERF IS CHARGED AT THE RIM HERE. The raw plate's own edge is cut, so an
-- unshared boundary costs one kerf wherever it is, including against the sheet
-- edge; two pieces that SHARE a boundary are one kerf apart, not two.

CREATE TABLE IF NOT EXISTS cf_nest_placements (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  company_id    INT            NOT NULL,
  plate_lot_id  INT            NOT NULL,
  cut_plate_id  INT            NOT NULL,        -- the temporary item master, i.e. the rectangle
  seq_no        INT            NOT NULL DEFAULT 1,   -- sequence on the plate, cut as a unit, in order
  row_no        INT            NOT NULL DEFAULT 1,   -- row within the sequence
  pos_no        INT            NOT NULL DEFAULT 1,   -- place along the row

  x_mm          DECIMAL(12,3)  NOT NULL,
  y_mm          DECIMAL(12,3)  NOT NULL,
  length_mm     DECIMAL(12,3)  NOT NULL,        -- as placed
  width_mm      DECIMAL(12,3)  NOT NULL,        -- as placed
  rotated       TINYINT(1)     NOT NULL DEFAULT 0,

  deleted_at    DATETIME       DEFAULT NULL,
  created_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT            NULL,

  is_live       TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cnp_tenant (company_id, id),
  UNIQUE KEY uq_cnp_place  (company_id, plate_lot_id, seq_no, row_no, pos_no, is_live),
  KEY idx_cnp_cut_order (company_id, plate_lot_id, seq_no, row_no, pos_no),
  KEY idx_cnp_plate     (company_id, cut_plate_id),

  CONSTRAINT fk_cnp_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cnp_lot     FOREIGN KEY (company_id, plate_lot_id) REFERENCES cf_plate_lots(company_id, id),
  CONSTRAINT fk_cnp_cut     FOREIGN KEY (company_id, cut_plate_id) REFERENCES cf_master_records(company_id, id),
  CONSTRAINT fk_cnp_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ===========================================================================
-- 23. CUT SETTINGS — the retrofit, and the shop's published kerf bands
-- ===========================================================================
--
-- ORDERING A PLATE: add the margin, THEN round up to the step. The margin is
-- real slack (mill edges are not straight) and must survive the rounding, so
-- rounding comes second. Note this does NOT reproduce the shop sheet's own
-- worked example, which takes 2562 -> 2600 (+38, a bare round-up leaving no
-- slack at all); under this rule the same case orders 2650. Decided that way
-- deliberately on 2026-09-25 — a bare round-up gives ZERO margin whenever the
-- requirement is already a round number, which defeats the reason it exists.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_cut_settings' AND COLUMN_NAME = 'order_step_mm');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_cut_settings ADD COLUMN order_step_mm DECIMAL(10,3) NOT NULL DEFAULT 50.000 AFTER order_margin_width_mm',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The three published kerf bands, per company, seeded once.
--
-- WHY THIS SEED EXISTS. Without it every company falls through to a single
-- built-in default of 3 mm for EVERY thickness, so a 40 mm plate would be
-- nested at 3 mm instead of 5 and every part on thick plate would come out
-- 2 mm undersized on each side. Silent, and only visible at the torch. Kerf
-- must have exactly one source of truth and this is it.
--
--   5 - 16 mm : 3 mm      (the sheet quotes 2.5-3; 3 is the safe end)
--   18 - 20 mm: 4 mm
--   25 - 50 mm: 5 mm
-- plus a default row for anything outside those bands.

INSERT INTO cf_cut_settings
  (company_id, thickness_min_mm, thickness_max_mm, kerf_mm, notes)
SELECT c.id, b.lo, b.hi, b.kerf, b.note
  FROM companies c
  JOIN (SELECT  5.000 AS lo, 16.000 AS hi, 3.000 AS kerf, 'PFPL published band 5-16 mm' AS note
        UNION ALL SELECT 18.000, 20.000, 4.000, 'PFPL published band 18-20 mm'
        UNION ALL SELECT 25.000, 50.000, 5.000, 'PFPL published band 25-50 mm'
        UNION ALL SELECT NULL,   NULL,   3.000, 'Default for thicknesses outside the published bands') b
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM cf_cut_settings x
                    WHERE x.company_id = c.id
                      AND x.deleted_at IS NULL
                      AND ((x.thickness_min_mm IS NULL AND b.lo IS NULL)
                           OR (x.thickness_min_mm = b.lo AND x.thickness_max_mm = b.hi)));

-- ===========================================================================
-- 24. NEST_MANUAL — holding a rectangle back from the packer
-- ===========================================================================
--
-- Some pieces are laid out by hand: an awkward offcut, a leftover, anything the
-- shop wants to place itself. NEST_MANUAL on a cut plate is how it is held back.
--
-- WHY IT IS SEEDED. nestingService READS it tolerantly — a company without the
-- specification simply has nothing marked manual. But WRITING a value needs an
-- assignment saying the specification applies and is `entered`, so without this
-- the toggle on the nesting screen returns 422 on a tenant nobody has hand-set
-- up. Reading and writing disagreeing about whether a thing exists is the kind
-- of gap that only shows up in front of a user.
--
-- `entered` on purpose: it reads the record's own row and is never inherited,
-- so marking one rectangle by hand cannot quietly mark its siblings.
--
-- The assignment is only created where a CUT_PLATE classification already
-- exists, because that node is tenant setup rather than app schema.

INSERT INTO cf_specifications (company_id, code, name, data_type, description, status)
SELECT c.id, 'NEST_MANUAL', 'Nest by hand', 'boolean',
       'Yes means the packer leaves this rectangle alone and somebody lays it out by hand, on the nesting screen or in the nesting sheet.',
       'active'
  FROM companies c
 WHERE c.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM cf_specifications s
                    WHERE s.company_id = c.id AND s.code = 'NEST_MANUAL' AND s.deleted_at IS NULL);

INSERT INTO cf_spec_assignments
  (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule)
SELECT n.company_id, s.id, 'classification', n.id, 'item', 0, 1, 'entered'
  FROM cf_classification_nodes n
  JOIN cf_specifications s
    ON s.company_id = n.company_id AND s.code = 'NEST_MANUAL' AND s.deleted_at IS NULL
 WHERE n.code = 'CUT_PLATE' AND n.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM cf_spec_assignments a
                    WHERE a.company_id = n.company_id AND a.specification_id = s.id
                      AND a.subject_type = 'classification' AND a.subject_id = n.id
                      AND a.deleted_at IS NULL);

-- ===========================================================================
-- 25. LOCK — a line's BOM is a design until it is locked
-- ===========================================================================
--
-- User, 2026-09-26: "the codes can't live on the BOM as it is yet to be rolled
-- out based on the quantity … once entered and locked I don't see a reason for
-- it to change." Until LOCK a line's rows are a design with quantities and no
-- codes. Locking rolls them out into pieces (cf_order_pieces, below) with their
-- real codes and freezes the line's structure, values and cut pieces.
--
-- lock_position is the line's number among the order's lines that sell the
-- same design (the `line.position` piece token, SPAN-01 / SPAN-02). It is given
-- at lock, counted over the lines that exist THEN — `position` above is unique
-- over deleted lines too (uq_csol_position), which is why a deleted trial line
-- left a gap; this one does not.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'locked_at');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_sales_order_lines ADD COLUMN locked_at DATETIME NULL, ADD COLUMN locked_by INT NULL, ADD COLUMN lock_position INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 26. ORDER PIECES — what a locked line rolls out into
-- ===========================================================================
--
-- A BOM row is a design with a quantity. Locking a line (services/lockService)
-- rolls its structure out into PIECES — one node per physical piece where the
-- piece has made parts of its own, identical parts grouped under their parent
-- piece, exactly the tree release lays out (services/rollOutService) — and
-- gives every node its real code, here, once. The line's structure, values and
-- cut pieces are frozen from then on.
--
-- Release does not make codes for a locked line: it lays its tracker out again
-- and takes each node's code from these rows by path_key. path_key names a node
-- by WHERE IT SITS, not by ids handed out in order: the chain from the top of
-- <bom line id>.<ordinal> — "L.1/3861.1/3862.1/3863.1/4071", L being the line's
-- own item. The ordinal is the piece's place among its OWN ROW's pieces under
-- ONE parent piece; a group has none. A frozen structure lays out the same way
-- every time, so the keys come out the same.
--
--   quantity   1 for a piece, the count for a group ("6 off")
--   piece_no   a piece's number among its design across the whole line; NULL for a group
--   piece_seq  what the code printed for piece.seq — a group's range reads "1-4"
--   rule_code  the coding rule that gave the code; NULL means none applied and
--              the built-in shape did
--
-- A later revision of the order retires a locked line's pieces (deleted_at).
-- code_live keeps a code unique among a company's LIVE pieces, so a retired
-- revision gives its codes back to the one that replaces it.

CREATE TABLE IF NOT EXISTS cf_order_pieces (
  id             INT            AUTO_INCREMENT PRIMARY KEY,
  company_id     INT            NOT NULL,
  order_id       INT            NOT NULL,
  order_line_id  INT            NOT NULL,
  parent_id      INT            NULL,
  item_id        INT            NOT NULL,          -- the row's temporary item, or a catalog item made on the order
  bom_line_id    INT            NULL,              -- the row it rolled out from; NULL for the line's own item
  piece_no       INT            NULL,
  piece_seq      VARCHAR(40)    NULL,
  quantity       DECIMAL(18,6)  NOT NULL,
  code           VARCHAR(150)   NOT NULL,
  rule_code      VARCHAR(100)   NULL,
  path_key       VARCHAR(600)   NOT NULL,
  depth          INT            NOT NULL,
  sort_order     INT            NOT NULL,          -- the roll-out order: a parent before its children, rows as shown

  deleted_at     DATETIME       DEFAULT NULL,      -- set only when a later revision of the order replaces the line
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT            NULL,

  code_live      VARCHAR(150)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL,

  UNIQUE KEY uq_copc_tenant (company_id, id),
  UNIQUE KEY uq_copc_code   (company_id, code_live),
  KEY idx_copc_line   (company_id, order_line_id, depth, sort_order),
  KEY idx_copc_order  (company_id, order_id),
  KEY idx_copc_parent (company_id, parent_id),
  KEY idx_copc_item   (company_id, item_id),
  KEY idx_copc_bom    (company_id, bom_line_id),

  CONSTRAINT fk_copc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_copc_order   FOREIGN KEY (company_id, order_id)      REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_copc_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_copc_parent  FOREIGN KEY (company_id, parent_id)     REFERENCES cf_order_pieces(company_id, id),
  CONSTRAINT fk_copc_item    FOREIGN KEY (company_id, item_id)       REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_copc_bomline FOREIGN KEY (company_id, bom_line_id)   REFERENCES cf_bom_lines(company_id, id),
  CONSTRAINT fk_copc_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ===========================================================================
-- 27. REVISIONS — a change after lock is a new revision of the same order
-- ===========================================================================
--
-- After LOCK a line's structure, values and cut pieces never change (§25). The
-- user, 2026-09-27: "If it changes, the whole sales order basically changes so
-- it should be a new one anyways" — and chose a new REVISION of the same order
-- ("SO-…-0001 rev 2") over a new order number.
--
-- A revision is another cf_sales_orders row with the SAME code and revision
-- + 1; revision_of_id names the row it revises. The row it replaced gets status
-- 'revised' — read-only, frozen exactly like 'closed' (records.js
-- LOCKED_ORDER_STATUSES) and left out of lists by default — with revised_at and
-- status_before_revised, the status it gets back if the new revision is
-- discarded. The locked revision's lines, rows and pieces stay as they were;
-- only its pieces are retired, when the new revision's first line locks, so
-- their codes are free for the same pieces again (services/revisionService.js).
--
-- The order number was unique on (company_id, code_active). It becomes unique
-- on (company_id, code_active, revision): the revisions of one order share the
-- number, two orders still cannot. The new key is made BEFORE the old one is
-- dropped, so the number is never without a unique key, even for a moment.
--
-- revises_line_id on a line names the line of the previous revision it was
-- copied from — how a line keeps its identity from one revision to the next.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND COLUMN_NAME = 'revision');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_sales_orders ADD COLUMN revision INT NOT NULL DEFAULT 1, ADD COLUMN revision_of_id INT NULL, ADD COLUMN revised_at DATETIME NULL, ADD COLUMN status_before_revised VARCHAR(20) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 'revised' is APPENDED to the list, never inserted: appending changes no
-- stored value, so it is a metadata change on MySQL and on TiDB alike.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders'
               AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%revised%');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_sales_orders MODIFY COLUMN status ENUM('draft','inquiry','quoted','confirmed','closed','lost','cancelled','revised') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The new key first ...
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND INDEX_NAME = 'uq_csor_code_revision');
SET @sql = IF(@idx = 0,
  'ALTER TABLE cf_sales_orders ADD UNIQUE KEY uq_csor_code_revision (company_id, code_active, revision)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ... then the old one, which would refuse rev 2 for carrying rev 1's number.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND INDEX_NAME = 'uq_csor_code');
SET @sql = IF(@idx > 0, 'ALTER TABLE cf_sales_orders DROP INDEX uq_csor_code', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A revision points at the revision it replaced, in the same company.
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND CONSTRAINT_NAME = 'fk_csor_revision_of');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_sales_orders ADD CONSTRAINT fk_csor_revision_of FOREIGN KEY (company_id, revision_of_id) REFERENCES cf_sales_orders(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A line of a revision points at the line it was copied from.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'revises_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_order_lines ADD COLUMN revises_line_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND CONSTRAINT_NAME = 'fk_csol_revises');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_sales_order_lines ADD CONSTRAINT fk_csol_revises FOREIGN KEY (company_id, revises_line_id) REFERENCES cf_sales_order_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 28. TABLE SPECIFICATIONS — a chart is a value too
-- ===========================================================================
--
-- Decided 2026-09-27, reading the plant's own rate charts (Process_Flow_v5.xlsx,
-- sheet Sample_Calculations — CNC cutting speed by plate thickness, drilling
-- time by thickness x hole diameter). The user: "Rate charts are SPECIFICATIONS
-- ON THE MACHINE, read by the formula ... this will be standard for every other
-- ERP implementation too." So a chart is not a one-off machine feature — it is
-- a fourth kind of specification VALUE, `table`, beside number/text/boolean/
-- date/option, usable wherever any other specification is: a machine, a
-- machine type, an item, a definition.
--
-- table_config (on the specification) is the chart's SHAPE, not its numbers:
-- one or two numeric axes, each `{ label, unit }`, and how a value between two
-- rows is read —
--   step_up  the first row AT OR ABOVE the asked value (a 10 mm plate takes the
--            12 mm speed off the chart — never a faster rate than it gives)
--   linear   a straight line between the two rows around the asked value
-- Outside the chart's own range, neither mode invents a number — the value
-- reads as missing, with the reason (formulaEngine.js, valueService.js). The
-- chart's OUTPUT unit is the specification's own default_uom, same as a number.
--
-- value_json (on the value) holds the chart's numbers:
--   1-D   { "x": [6, 8, 12], "v": [3535, 2860, 1700] }
--   2-D   { "x": [...], "y": [...], "v": [[...], ...] }, v[yIndex][xIndex]
-- `null` in v means the machine cannot do it at that row/column — the chart's
-- own "x" (a plain absence of a value there — never confused with "not entered
-- yet", which is the whole value_json column being NULL).
--
-- Rules and history need no new machinery: `fixed`/`defaulted` on a machine
-- TYPE and `entered` on one machine already mean "most specific wins" for any
-- specification (cf_spec_assignments, §5), and cf_spec_value_history already
-- stores old/new values as JSON (§6a) — a table's old/new is just more JSON.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_specifications'
               AND COLUMN_NAME = 'data_type' AND COLUMN_TYPE LIKE '%table%');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_specifications MODIFY COLUMN data_type ENUM('number','text','boolean','date','option','table') NOT NULL DEFAULT 'number'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_specifications' AND COLUMN_NAME = 'table_config');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_specifications ADD COLUMN table_config JSON NULL AFTER decimals',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_spec_values' AND COLUMN_NAME = 'value_json');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_spec_values ADD COLUMN value_json JSON NULL AFTER option_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 29. IMPORTED NESTS, A RULE CHECK THAT WARNS, WASTE BY CAUSE, OFFCUTS
-- ===========================================================================
--
-- Decided 2026-09-29 (CF_ERP_NESTING_PLAN, last section). The user: people
-- often nest in another program and get a plan of several nests, each ONE
-- standard plate plus the cut plates on it with quantities. They bring that in
-- by Excel; or import some and let us nest the rest; or let us nest it all.
-- An imported nest is CHECKED against our rules and we SAY whether it will
-- work, but they may save it anyway.
--
-- cf_plate_lots gains
--   origin         'auto' = our packer laid it out; 'imported' = it came in
--                  from the nesting sheet. "Nest the rest" clears only 'auto'.
--   check_verdict  fits / tight / wont_fit, our check of an imported nest.
--                  NULL on an automatic lot (it fits by construction).
--   check_json     the reasons, as plain sentences.
--   forced         1 = saved although the verdict was not `fits`.
--   waste_json     the plate split by cause (nestGeometry.analyseNest):
--                  kerf, sequence gaps, rim, offcut and what is left, wastage.
--
-- cf_nest_placements.x_mm / y_mm become NULLable: NULL means the piece IS on
-- that plate but we found no layout for it (an imported nest our packer could
-- not fit; their program may have). Widened only; nothing stored changes.
--
-- cf_cut_settings gains the offcut thresholds: a left-over region is a
-- reusable offcut when its area is at least offcut_min_area_mm2 (300 x 300)
-- AND the short side of its largest inscribed rectangle is at least
-- offcut_min_side_mm (a long sliver between rows is not reusable). Anything
-- smaller is wastage.
--
-- cf_offcuts: every reusable offcut of every saved lot, with its outline. It is
-- NOT a catalog item (its sizes are not item-level); it points at its lot.
-- Reuse is not built yet; these rows are the stock it will draw on.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'origin');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_plate_lots ADD COLUMN origin ENUM('auto','imported') NOT NULL DEFAULT 'auto' AFTER is_manual",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'check_verdict');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_plate_lots ADD COLUMN check_verdict ENUM('fits','tight','wont_fit') NULL AFTER origin",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'check_json');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_plate_lots ADD COLUMN check_json JSON NULL AFTER check_verdict',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'forced');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_plate_lots ADD COLUMN forced TINYINT(1) NOT NULL DEFAULT 0 AFTER check_json',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'waste_json');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_plate_lots ADD COLUMN waste_json JSON NULL AFTER forced',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Widen to NULL, only while they are still NOT NULL.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_nest_placements'
               AND COLUMN_NAME = 'x_mm' AND IS_NULLABLE = 'NO');
SET @sql = IF(@col > 0,
  'ALTER TABLE cf_nest_placements MODIFY COLUMN x_mm DECIMAL(12,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_nest_placements'
               AND COLUMN_NAME = 'y_mm' AND IS_NULLABLE = 'NO');
SET @sql = IF(@col > 0,
  'ALTER TABLE cf_nest_placements MODIFY COLUMN y_mm DECIMAL(12,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_cut_settings' AND COLUMN_NAME = 'offcut_min_area_mm2');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_cut_settings ADD COLUMN offcut_min_area_mm2 DECIMAL(14,3) NOT NULL DEFAULT 90000.000',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_cut_settings' AND COLUMN_NAME = 'offcut_min_side_mm');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_cut_settings ADD COLUMN offcut_min_side_mm DECIMAL(10,3) NOT NULL DEFAULT 100.000',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- One row per reusable offcut. offcut_no is `<lotNo>-A`, `-B` ... within the
-- line. rect_* is the largest inscribed axis-aligned rectangle (what a future
-- packer can put a part in); bbox_* the region's bounding box; outline_json the
-- region itself: a list of polygons, each a list of [x, y] in plate
-- coordinates, mm, origin at the plate's bottom-left corner. The x/y corners of
-- rect and bbox are kept too, so the screen can draw them without re-deriving.
CREATE TABLE IF NOT EXISTS cf_offcuts (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  plate_lot_id    INT            NOT NULL,
  offcut_no       VARCHAR(40)    NOT NULL,
  thickness_mm    DECIMAL(10,3)  NULL,
  grade           VARCHAR(100)   NULL,
  material        VARCHAR(100)   NULL,
  density         DECIMAL(12,3)  NULL,
  area_mm2        DECIMAL(16,3)  NOT NULL,
  weight_kg       DECIMAL(14,3)  NULL,
  bbox_x_mm       DECIMAL(12,3)  NULL,
  bbox_y_mm       DECIMAL(12,3)  NULL,
  bbox_length_mm  DECIMAL(12,3)  NULL,
  bbox_width_mm   DECIMAL(12,3)  NULL,
  rect_x_mm       DECIMAL(12,3)  NULL,
  rect_y_mm       DECIMAL(12,3)  NULL,
  rect_length_mm  DECIMAL(12,3)  NULL,
  rect_width_mm   DECIMAL(12,3)  NULL,
  outline_json    JSON           NULL,
  status          ENUM('planned','available','used','scrapped','returned') NOT NULL DEFAULT 'planned',
  notes           VARCHAR(500)   NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  UNIQUE KEY uq_cofc_tenant (company_id, id),
  KEY idx_cofc_line  (company_id, order_line_id),
  KEY idx_cofc_lot   (company_id, plate_lot_id),
  KEY idx_cofc_steel (company_id, thickness_mm, status),

  CONSTRAINT fk_cofc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cofc_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cofc_lot     FOREIGN KEY (company_id, plate_lot_id) REFERENCES cf_plate_lots(company_id, id),
  CONSTRAINT fk_cofc_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ===========================================================================
-- 30. TIME OVERRIDES AND CONTRACTOR WORK ORDERS
-- ===========================================================================
--
-- Decided 2026-09-29 (TM/CF_ERP_TIMES_WORKORDERS_PLAN.md). The user: in the
-- order's Production step, the BOM rows down the side and the operations across
-- the top; each box holds the time the formula worked out, and a person may type
-- over it. Then: split the production order into WORK ORDERS done by
-- contractors, at the piece tree x operation level ("L11 by one contractor for
-- some operations, L12 by another").
--
-- cf_time_overrides: a typed time for one (row, operation) of one order line.
--   A time is WORK MINUTES PER PIECE; setup (once per run) stays with the
--   formula unless typed over too. NULL in either column = use the formula; a
--   row with both NULL is retired (deleted_at) rather than kept. bom_line_id
--   NULL = the line's own item (it sits on no BOM row). Rows are designs, so an
--   override holds for every piece the row rolls out into. Editable until
--   release; at release the time is copied onto the production steps (est_*).
--
-- cf_production_steps gains
--   est_setup_minutes, est_work_minutes (per piece), est_minutes (= setup +
--   work x the step's quantity): filled at release from the same computation
--   the Times grid shows (override if any, else formula). NULL = no estimate
--   (a rule without a time, a missing input), never an invented number.
--   work_order_id: the contractor work order the step belongs to; NULL = in-house.
--
-- cf_production_items gains order_piece_id: the locked piece the node was laid
-- out from (rollOutService.attachLockedCodes matched it by path key). Releases
-- made before this column have NULL and are matched by code.
--
-- cf_work_orders: a contractor's share of one order line. Contractor = a party
--   with is_subcontractor = 1 (the party master already has the role; no new
--   master). code from the code generator (entity work_order), else WO-000123,
--   stamped after the insert like a purchase order's number.
--   status  draft -> issued -> in_progress -> done; an open one may be
--   cancelled, which frees its cells.
--
-- cf_work_order_cells: which (piece, operation) cells a work order holds. ONE
--   owner per live cell (uq_cwoc_cell); a cell on no work order is in-house. A
--   cell may be moved until that operation starts on the floor (decision 2).
--   When a later revision retires the pieces, their cells are retired with them
--   (lockService -> workOrderService.retireCellsOfRetiredPieces).

CREATE TABLE IF NOT EXISTS cf_time_overrides (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  bom_line_id     INT            NULL,              -- NULL = the line's own item
  operation_id    INT            NOT NULL,
  work_minutes    DECIMAL(12,3)  NULL,              -- per piece; NULL = the formula's
  setup_minutes   DECIMAL(12,3)  NULL,              -- per run;   NULL = the formula's
  note            VARCHAR(300)   NULL,
  updated_by      INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  bom_key         INT            GENERATED ALWAYS AS (IFNULL(bom_line_id, 0)) VIRTUAL,
  is_live         TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_ctov_tenant (company_id, id),
  UNIQUE KEY uq_ctov_cell   (company_id, order_line_id, bom_key, operation_id, is_live),
  KEY idx_ctov_bom (company_id, bom_line_id),

  CONSTRAINT fk_ctov_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ctov_line      FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_ctov_bomline   FOREIGN KEY (company_id, bom_line_id)   REFERENCES cf_bom_lines(company_id, id),
  CONSTRAINT fk_ctov_operation FOREIGN KEY (company_id, operation_id)  REFERENCES cf_operations(company_id, id),
  CONSTRAINT fk_ctov_updater   FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_work_orders (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  -- NULL only between the insert and the number being stamped (WO-000123 needs
  -- the row's own id when no coding rule answers). Never NULL once committed.
  code            VARCHAR(100)   NULL,
  order_id        INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  contractor_id   INT            NOT NULL,          -- cf_parties, is_subcontractor = 1
  status          ENUM('draft','issued','in_progress','done','cancelled') NOT NULL DEFAULT 'draft',
  start_date      DATE           NULL,
  due_date        DATE           NULL,
  notes           TEXT           NULL,
  created_by      INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  code_active     VARCHAR(100)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cwo_tenant (company_id, id),
  UNIQUE KEY uq_cwo_code   (company_id, code_active),
  KEY idx_cwo_line       (company_id, order_line_id, contractor_id, status),
  KEY idx_cwo_order      (company_id, order_id),
  KEY idx_cwo_contractor (company_id, contractor_id, status),

  CONSTRAINT fk_cwo_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cwo_order      FOREIGN KEY (company_id, order_id)      REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_cwo_line       FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cwo_contractor FOREIGN KEY (company_id, contractor_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_cwo_creator    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_work_order_cells (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  work_order_id   INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  order_piece_id  INT            NOT NULL,
  operation_id    INT            NOT NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  is_live         TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cwoc_tenant (company_id, id),
  UNIQUE KEY uq_cwoc_cell   (company_id, order_piece_id, operation_id, is_live),
  KEY idx_cwoc_order (company_id, work_order_id),
  KEY idx_cwoc_line  (company_id, order_line_id),

  CONSTRAINT fk_cwoc_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cwoc_order     FOREIGN KEY (company_id, work_order_id)  REFERENCES cf_work_orders(company_id, id),
  CONSTRAINT fk_cwoc_line      FOREIGN KEY (company_id, order_line_id)  REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cwoc_piece     FOREIGN KEY (company_id, order_piece_id) REFERENCES cf_order_pieces(company_id, id),
  CONSTRAINT fk_cwoc_operation FOREIGN KEY (company_id, operation_id)   REFERENCES cf_operations(company_id, id)
);

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_steps' AND COLUMN_NAME = 'est_setup_minutes');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_production_steps ADD COLUMN est_setup_minutes DECIMAL(12,3) NULL, ADD COLUMN est_work_minutes DECIMAL(12,3) NULL, ADD COLUMN est_minutes DECIMAL(14,3) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_steps' AND COLUMN_NAME = 'work_order_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_production_steps ADD COLUMN work_order_id INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- TiDB cannot index a column in the same ALTER that adds it, so the key is its own guarded step.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_steps' AND INDEX_NAME = 'idx_cprs_work_order');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_production_steps ADD KEY idx_cprs_work_order (company_id, work_order_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_steps' AND CONSTRAINT_NAME = 'fk_cprs_work_order');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_production_steps ADD CONSTRAINT fk_cprs_work_order FOREIGN KEY (company_id, work_order_id) REFERENCES cf_work_orders(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_items' AND COLUMN_NAME = 'order_piece_id');
SET @sql = IF(@col = 0,
  'ALTER TABLE cf_production_items ADD COLUMN order_piece_id INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- TiDB cannot index a column in the same ALTER that adds it, so the key is its own guarded step.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_items' AND INDEX_NAME = 'idx_cpri_piece');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_production_items ADD KEY idx_cpri_piece (company_id, order_piece_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_items' AND CONSTRAINT_NAME = 'fk_cpri_order_piece');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_production_items ADD CONSTRAINT fk_cpri_order_piece FOREIGN KEY (company_id, order_piece_id) REFERENCES cf_order_pieces(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 31. THE PLANNER — this month and the next two, by priority and a tonnes goal
-- ===========================================================================
--
-- Decided 2026-09-29 (TM/CF_ERP_PLANNER_PLAN.md). The user: plan this month and
-- the next two automatically from the orders, by order priority and a monthly
-- output goal; plan a whole order or break it down through the BOM; plan by
-- SHIPPING MARKS ("if we set that at least one line should be shipped, that is
-- what gets optimised"); never plan work before its material can be there.
--
-- cf_sales_orders.plan_priority   1 = plan first; NULL = after every ranked
--   order, by committed date. Written as a whole ranking (PUT /planner/priorities).
-- cf_sales_order_lines.plan_level 'line' (the whole line) or a depth of the
--   locked piece tree as text ('0' = the line's own pieces, e.g. a span).
--   NULL = the default: the shipping-group depth when the line has marks.
--
-- cf_plan_entries: where a plan unit ships. ONE live plan per company (no
--   scenarios in v1). unit_key = 'p<order piece id>', 'l<order line id>' or 'g<parent piece id>.<bom line id>' (a lot of loose pieces);
--   ship_date = the START of the period it ships in. pinned = moved by hand —
--   auto-plan never moves it. Unplanning retires the row (deleted_at).
-- cf_plan_targets: the monthly goal, TONNES SHIPPED (decision 2), per month
--   (the first of the month). Clearing a goal removes its row.
-- cf_plan_settings: one row per company; no row = the defaults below.
--
-- SHIP_UNIT ("Ships as one unit") is the shipping mark (decision 1): a piece
-- whose item says yes is a mark; the parent of marks is a shipping line. It is
-- set ONCE on a template definition (e.g. Girder segment), so the rule is
-- `defaulted`: an item made from the definition reads the definition's value
-- through its chain (resolutionService: Family > Subfamily > Variant >
-- Template definition > the record) unless it says otherwise itself. Seeded
-- per cf_erp company (a company with a live cf_erp app row), and assigned on
-- the Families that hold template definitions. The planner reads it
-- tolerantly, but WRITING a value needs an assignment (§24 says why).
-- No keys are added to an existing table here, so nothing trips TiDB's
-- "cannot index a column in the ALTER that adds it".

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_orders' AND COLUMN_NAME = 'plan_priority');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_orders ADD COLUMN plan_priority INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'plan_level');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_order_lines ADD COLUMN plan_level VARCHAR(20) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS cf_plan_entries (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  unit_key        VARCHAR(40)    NOT NULL,          -- 'p<piece id>' | 'l<line id>' | 'g<parent piece id>.<bom line id>'
  ship_date       DATE           NOT NULL,          -- the start of the period it ships in
  pinned          TINYINT        NOT NULL DEFAULT 0,
  updated_by      INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  is_live         TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cpe_tenant (company_id, id),
  UNIQUE KEY uq_cpe_unit   (company_id, unit_key, is_live),
  KEY idx_cpe_line (company_id, order_line_id),

  CONSTRAINT fk_cpe_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpe_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cpe_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_plan_targets (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  month           DATE           NOT NULL,          -- the first of the month
  tonnes          DECIMAL(12,3)  NOT NULL,
  updated_by      INT            NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cplt_month (company_id, month),

  CONSTRAINT fk_cplt_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cplt_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_plan_settings (
  company_id           INT       NOT NULL PRIMARY KEY,
  min_lines_per_month  INT       NOT NULL DEFAULT 1,
  allow_partial_lines  TINYINT   NOT NULL DEFAULT 1,
  updated_by           INT       NULL,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_cpls_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpls_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

INSERT INTO cf_specifications (company_id, code, name, data_type, description, status)
SELECT c.id, 'SHIP_UNIT', 'Ships as one unit', 'boolean',
       'Yes means a piece of this kind is a shipping mark: it leaves the works as one unit, and the planner plans by it. Set it once on the template definition (for example Girder segment); everything made from it follows.',
       'active'
  FROM companies c
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM apps ap WHERE ap.company_id = c.id AND ap.slug = 'cf_erp' AND ap.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM cf_specifications s
                    WHERE s.company_id = c.id AND s.code = 'SHIP_UNIT' AND s.deleted_at IS NULL);

-- The Family (depth 0) of every template definition: the definition's own node
-- when it is filed on a Family, else its parent's or grandparent's.
INSERT INTO cf_spec_assignments
  (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule)
SELECT f.company_id, s.id, 'classification', f.id, 'item', 0, 1, 'defaulted'
  FROM cf_classification_nodes f
  JOIN cf_specifications s
    ON s.company_id = f.company_id AND s.code = 'SHIP_UNIT' AND s.deleted_at IS NULL
 WHERE f.depth = 0 AND f.deleted_at IS NULL AND f.scope <> 'machine'
   AND EXISTS (SELECT 1
                 FROM cf_master_records m
                 JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template' AND d.deleted_at IS NULL
                 JOIN cf_classification_nodes n  ON n.id = m.classification_id
                 LEFT JOIN cf_classification_nodes p1 ON p1.id = n.parent_id
                 LEFT JOIN cf_classification_nodes p2 ON p2.id = p1.parent_id
                WHERE m.company_id = f.company_id AND m.deleted_at IS NULL
                  AND f.id = CASE n.depth WHEN 0 THEN n.id WHEN 1 THEN p1.id ELSE p2.id END)
   AND NOT EXISTS (SELECT 1 FROM cf_spec_assignments a
                    WHERE a.company_id = f.company_id AND a.specification_id = s.id
                      AND a.subject_type = 'classification' AND a.subject_id = f.id
                      AND a.deleted_at IS NULL);

-- ===========================================================================
-- 32. THE MACHINE LOG — what each machine did, and when it stood still
-- ===========================================================================
--
-- Decided 2026-09-30 (TM/CF_ERP_FLOOR_LOG_PLAN.md). The user: a very easy way
-- to enter, per machine, what work happened and the blocks of time when no work
-- happened, with a reason from a list — noted on paper and entered at the
-- machine at the end of the day, or live: start, pause, stop. Several jobs can
-- run together.
--
-- TIMES ON THE FLOOR ARE THE PLANT CLOCK, the same frame as the shifts
-- (cf_machine_shifts): cf_work_sessions and cf_machine_stops store full
-- date-times in the plant's local time (never a bare time of day — a night
-- shift crosses midnight). The plant's zone is cf_floor_settings.timezone.
-- The step columns (started_at / finished_at) and cf_step_events.at keep the
-- frame NOW() writes, as before; floorService converts between the two.
--
-- cf_operators          who works the machines (a shared tablet: tap your name).
-- cf_operator_machines  an operator's usual machines — listed first, never a limit.
-- cf_stop_reasons       why a machine stood still; seeded per cf_erp company with
--                       the plan's twelve. "Other" needs a note.
-- cf_work_sessions      one continuous span of ONE step on ONE machine.
--                       ended_at NULL = running now; end_kind pause | done | stop.
--                       Sessions of different steps may overlap (jobs together);
--                       a step has at most one open session (uq_cfws_open).
--                       qty_good / qty_scrap = what was recorded with this span
--                       (the step keeps the totals). An edit is a soft delete +
--                       a new row whose replaces_id names the old one.
-- cf_machine_stops      a span the machine stood still, with a reason. ended_at
--                       NULL = still stopped; one open stop per machine
--                       (uq_cfms_open). A stop never overlaps a work session of
--                       the same machine, nor another stop (floorService checks).
-- cf_floor_settings     the plant's time zone, per company; no row = the default
--                       in floorService (env CF_PLANT_TIMEZONE, else Asia/Kolkata).
-- cf_step_events gains  at (when it happened; NULL = created_at), operator_id,
--                       source (tracker | live | day_entry), session_id, and
--                       before_ready — 1 = recorded before the step was ready
--                       (readiness is not a gate for logging actuals: flagged,
--                       never blocked).
-- Feature cf_erp_floor  read + record on the floor screens; granted to every
--                       role that already has cf_erp_production_manage.
-- Keys on the new cf_step_events columns are their own guarded steps (TiDB
-- cannot index a column in the ALTER that adds it).

CREATE TABLE IF NOT EXISTS cf_operators (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  code            VARCHAR(50)    NOT NULL,
  name            VARCHAR(150)   NOT NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes           VARCHAR(500)   NULL,
  created_by      INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  code_active     VARCHAR(50)    GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cfop_tenant (company_id, id),
  UNIQUE KEY uq_cfop_code   (company_id, code_active),

  CONSTRAINT fk_cfop_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cfop_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_operator_machines (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  operator_id     INT            NOT NULL,
  machine_id      INT            NOT NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  is_live         TINYINT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_cfom_tenant (company_id, id),
  UNIQUE KEY uq_cfom_pair   (company_id, operator_id, machine_id, is_live),
  KEY idx_cfom_machine (company_id, machine_id),

  CONSTRAINT fk_cfom_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cfom_operator FOREIGN KEY (company_id, operator_id) REFERENCES cf_operators(company_id, id),
  CONSTRAINT fk_cfom_machine  FOREIGN KEY (company_id, machine_id)  REFERENCES cf_machines(company_id, id)
);

CREATE TABLE IF NOT EXISTS cf_stop_reasons (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  code            VARCHAR(40)    NOT NULL,
  label           VARCHAR(100)   NOT NULL,
  sort_order      INT            NOT NULL DEFAULT 0,
  needs_note      TINYINT(1)     NOT NULL DEFAULT 0,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  code_active     VARCHAR(40)    GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cfsr_tenant (company_id, id),
  UNIQUE KEY uq_cfsr_code   (company_id, code_active),

  CONSTRAINT fk_cfsr_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS cf_work_sessions (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  machine_id      INT            NOT NULL,
  step_id         INT            NOT NULL,
  operator_id     INT            NULL,
  started_at      DATETIME       NOT NULL,          -- plant clock
  ended_at        DATETIME       NULL,              -- NULL = running now
  end_kind        ENUM('pause','done','stop') NULL,
  source          ENUM('live','day_entry') NOT NULL,
  qty_good        DECIMAL(18,6)  NOT NULL DEFAULT 0,
  qty_scrap       DECIMAL(18,6)  NOT NULL DEFAULT 0,
  before_ready    TINYINT(1)     NOT NULL DEFAULT 0,
  replaces_id     INT            NULL,              -- the row this edit replaced
  note            VARCHAR(500)   NULL,
  entered_by      INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  open_step       INT            GENERATED ALWAYS AS (IF(ended_at IS NULL AND deleted_at IS NULL, step_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_cfws_tenant (company_id, id),
  UNIQUE KEY uq_cfws_open   (company_id, open_step),
  KEY idx_cfws_machine (company_id, machine_id, started_at),
  KEY idx_cfws_step    (company_id, step_id),

  CONSTRAINT fk_cfws_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cfws_machine  FOREIGN KEY (company_id, machine_id)  REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_cfws_step     FOREIGN KEY (company_id, step_id)     REFERENCES cf_production_steps(company_id, id),
  CONSTRAINT fk_cfws_operator FOREIGN KEY (company_id, operator_id) REFERENCES cf_operators(company_id, id),
  CONSTRAINT fk_cfws_enterer  FOREIGN KEY (entered_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_machine_stops (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  machine_id      INT            NOT NULL,
  started_at      DATETIME       NOT NULL,          -- plant clock
  ended_at        DATETIME       NULL,              -- NULL = still stopped
  reason_id       INT            NOT NULL,
  note            VARCHAR(500)   NULL,
  operator_id     INT            NULL,
  source          ENUM('live','day_entry') NOT NULL,
  replaces_id     INT            NULL,
  entered_by      INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  open_machine    INT            GENERATED ALWAYS AS (IF(ended_at IS NULL AND deleted_at IS NULL, machine_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_cfms_tenant (company_id, id),
  UNIQUE KEY uq_cfms_open   (company_id, open_machine),
  KEY idx_cfms_machine (company_id, machine_id, started_at),

  CONSTRAINT fk_cfms_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cfms_machine  FOREIGN KEY (company_id, machine_id)  REFERENCES cf_machines(company_id, id),
  CONSTRAINT fk_cfms_reason   FOREIGN KEY (company_id, reason_id)   REFERENCES cf_stop_reasons(company_id, id),
  CONSTRAINT fk_cfms_operator FOREIGN KEY (company_id, operator_id) REFERENCES cf_operators(company_id, id),
  CONSTRAINT fk_cfms_enterer  FOREIGN KEY (entered_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_floor_settings (
  company_id      INT            NOT NULL PRIMARY KEY,
  timezone        VARCHAR(64)    NOT NULL,          -- IANA zone of the plant clock, e.g. Asia/Kolkata
  updated_by      INT            NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_cffs_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cffs_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_step_events' AND COLUMN_NAME = 'at');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_step_events ADD COLUMN at DATETIME NULL, ADD COLUMN operator_id INT NULL, ADD COLUMN source ENUM('tracker','live','day_entry') NULL, ADD COLUMN session_id INT NULL, ADD COLUMN before_ready TINYINT(1) NOT NULL DEFAULT 0",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- TiDB cannot index a column in the same ALTER that adds it, so the key is its own guarded step.
SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_step_events' AND INDEX_NAME = 'idx_csev_operator');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_step_events ADD KEY idx_csev_operator (company_id, operator_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_step_events' AND CONSTRAINT_NAME = 'fk_csev_operator');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_step_events ADD CONSTRAINT fk_csev_operator FOREIGN KEY (company_id, operator_id) REFERENCES cf_operators(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The twelve reasons, for every cf_erp company that has none yet (a company
-- whose list was edited is never re-seeded: a deleted reason stays deleted).
-- floorService.DEFAULT_STOP_REASONS is the same list, for companies set up later.
INSERT INTO cf_stop_reasons (company_id, code, label, sort_order, needs_note)
SELECT c.id, x.code, x.label, x.sort_order, x.needs_note
  FROM companies c
  JOIN (
    SELECT 'NO_MATERIAL' AS code, 'No material' AS label, 10 AS sort_order, 0 AS needs_note UNION ALL
    SELECT 'CRANE',       'Waiting for crane',        20, 0 UNION ALL
    SELECT 'PREV_JOB',    'Waiting for previous job', 30, 0 UNION ALL
    SELECT 'BREAKDOWN',   'Breakdown',                40, 0 UNION ALL
    SELECT 'POWER',       'Power cut',                50, 0 UNION ALL
    SELECT 'NO_OPERATOR', 'No operator',              60, 0 UNION ALL
    SELECT 'SETUP',       'Setup / changeover',       70, 0 UNION ALL
    SELECT 'BREAK',       'Meal / tea break',         80, 0 UNION ALL
    SELECT 'QUALITY',     'Quality hold',             90, 0 UNION ALL
    SELECT 'DRAWING',     'Waiting for drawing',     100, 0 UNION ALL
    SELECT 'CLEANING',    'Cleaning / maintenance',  110, 0 UNION ALL
    SELECT 'OTHER',       'Other',                   120, 1
  ) x
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM apps ap WHERE ap.company_id = c.id AND ap.slug = 'cf_erp' AND ap.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM cf_stop_reasons r WHERE r.company_id = c.id);

-- The floor permission: a feature, its capability, and a grant to every role
-- (team, company) that already has production manage, for the same app.
-- models/seed.sql lists cf_erp_floor too, so a fresh database's admin gets it.
INSERT INTO features (feature_name, feature_tag, type)
SELECT 'CF ERP: record work on the shop floor', 'cf_erp_floor', 'frontend'
 WHERE NOT EXISTS (SELECT 1 FROM features f WHERE f.feature_tag = 'cf_erp_floor');

INSERT INTO features_capability (name, features_json)
SELECT f.feature_tag, JSON_ARRAY(f.id)
  FROM features f
 WHERE f.feature_tag = 'cf_erp_floor' AND f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM features_capability fc WHERE fc.name = 'cf_erp_floor' AND fc.deleted_at IS NULL);

INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT DISTINCT rc.role_id, rc.team_id, rc.company_id, rc.app_id, fl.capability_id
  FROM role_capability rc
  -- Any capability that CONTAINS production manage, whatever it is called
  -- (in production it sits in a bundle with another name, so a name match missed it).
  JOIN features_capability pm ON pm.capability_id = rc.capability_id AND pm.deleted_at IS NULL
  JOIN features pf ON pf.feature_tag = 'cf_erp_production_manage' AND pf.deleted_at IS NULL
                  AND JSON_CONTAINS(pm.features_json, CAST(pf.id AS JSON))
  JOIN features_capability fl ON fl.name = 'cf_erp_floor' AND fl.deleted_at IS NULL
 WHERE rc.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability x
      WHERE x.capability_id = fl.capability_id AND x.deleted_at IS NULL
        AND x.role_id <=> rc.role_id AND x.team_id <=> rc.team_id
        AND x.company_id <=> rc.company_id AND x.app_id <=> rc.app_id);

-- ===========================================================================
-- 33. HOUSE SETTINGS — the flow cut plates are made by
-- ===========================================================================
--
-- Decided 2026-09-30: CUTTING belongs to the cut plate. A cut plate is made by
-- a cutting flow (e.g. "CNC Cutting"), and the part cut from it no longer has a
-- cutting step. Automatic cut pieces (cutPlateService.refreshCutPieces) make
-- new cut plates without anybody choosing a flow, so release refused every one
-- of them ("has no flow — say how it is made"). This row says which flow a NEW
-- cut plate takes; a flow already set on a cut plate is never overwritten.
-- Set on Production › Flows ("Cut plates are made by").
--
-- One row per company; no row = no default (the old behaviour). A new table,
-- so no key is added to an existing table in an ALTER (TiDB).

CREATE TABLE IF NOT EXISTS cf_company_settings (
  company_id         INT       NOT NULL PRIMARY KEY,
  cut_plate_flow_id  INT       NULL,
  updated_by         INT       NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_cfcs_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cfcs_cut_flow FOREIGN KEY (company_id, cut_plate_flow_id) REFERENCES cf_operation_flows(company_id, id),
  CONSTRAINT fk_cfcs_updater  FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- ===========================================================================
-- 34. NEST WAITS — every cut plate on a plate lot waits for that lot's plate
-- ===========================================================================
--
-- Decided 2026-09-30: a nested line's raw plate is one requirement per plate
-- lot, held on ONE cut plate's first step (the lot's "gate", releaseService
-- "raw plate from the nest"). Every piece on a lot is cut from that one plate in
-- one CNC program, so every OTHER cut-plate node on the lot waits for the gate
-- step to START — origin 'nest'. Appending a value to the ENUM is all it takes
-- (no key, no data rewrite). Guarded: only while 'nest' is missing.

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_step_dependencies'
               AND COLUMN_NAME = 'origin' AND COLUMN_TYPE NOT LIKE '%''nest''%');
SET @sql = IF(@col > 0,
  "ALTER TABLE cf_step_dependencies MODIFY COLUMN origin ENUM('flow','rule','default','nest') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 35. STOCK MONEY AND OWNERSHIP — cost on every lot and ledger line, and whose
--     stock it is (CF_ERP_MONEY_PLAN §1–2)
-- ===========================================================================
--
-- Decided 2026-09-30 (user): "Track whether stock is OURS or the CUSTOMER'S —
-- customers sometimes supply raw material, and the wastage has to be tracked
-- and given back. Keep the COST of all stock at GRN."
--
-- OWNERSHIP lives on the LOT. cf_stock_batches.owner_party_id NULL = ours; a
-- customer party = theirs, with owner_order_id the sales order it was supplied
-- for (matched by order NUMBER, so a revision keeps its customer's material).
-- Loose stock (batch_id NULL) is always ours: customer material always arrives
-- as a lot, even for an item counted by quantity (stockService.postMovement).
-- Offcuts and plate lots carry the owner of the plate they are cut from.
--
-- COST follows the item's tracking level (cf_item_details.tracked_by):
--   batch       the lot's unit_cost, set by its receipt
--   individual  a unit IS a lot of one — production's lot (production_item_id);
--               its unit_cost stays NULL until production costing exists
--   quantity    loose stock: one weighted average per item (and owner) in
--               cf_item_costs. costed_qty is the quantity the average covers:
--               stock that was on the shelf before costs were kept has no cost
--               and stays "not costed" — NULL is unknown, never 0.
-- Every ledger row records the unit cost and the value it moved (signed like
-- quantity). Money: DECIMAL(18,4) unit costs, DECIMAL(18,2) values, INR.
--
-- A 'return' movement gives customer material back; return_kg records scrap
-- handed back by weight. An issue now fills cf_stock_movements.order_line_id
-- (§15 added it for shipments) with the line it was issued for, so job cost is
-- per line; idx_csm_order serves the per-order reads.
--
-- Every ADD is guarded on its own; every key and foreign key is its own guarded
-- ALTER after its column (TiDB cannot index a column in the ALTER that adds
-- it). ENUM values are only APPENDED. No backfill: existing lots are ours and
-- not costed.

-- ---- 35a. Lots: owner and cost -------------------------------------------------
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND COLUMN_NAME = 'owner_party_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_batches ADD COLUMN owner_party_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND COLUMN_NAME = 'owner_order_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_batches ADD COLUMN owner_order_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND COLUMN_NAME = 'unit_cost');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_batches ADD COLUMN unit_cost DECIMAL(18,4) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND COLUMN_NAME = 'currency');
SET @sql = IF(@col = 0, "ALTER TABLE cf_stock_batches ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND INDEX_NAME = 'idx_csb_owner');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_stock_batches ADD KEY idx_csb_owner (company_id, owner_party_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND INDEX_NAME = 'idx_csb_owner_order');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_stock_batches ADD KEY idx_csb_owner_order (company_id, owner_order_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND CONSTRAINT_NAME = 'fk_csb_owner');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_stock_batches ADD CONSTRAINT fk_csb_owner FOREIGN KEY (company_id, owner_party_id) REFERENCES cf_parties(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_batches' AND CONSTRAINT_NAME = 'fk_csb_owner_order');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_stock_batches ADD CONSTRAINT fk_csb_owner_order FOREIGN KEY (company_id, owner_order_id) REFERENCES cf_sales_orders(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 35b. Ledger rows: the cost and value each row moved ------------------------
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_ledger' AND COLUMN_NAME = 'unit_cost');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_ledger ADD COLUMN unit_cost DECIMAL(18,4) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_ledger' AND COLUMN_NAME = 'value');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_ledger ADD COLUMN value DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_ledger' AND COLUMN_NAME = 'currency');
SET @sql = IF(@col = 0, "ALTER TABLE cf_stock_ledger ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 35c. Movements: 'return', scrap returned by weight, the line issued for ----
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements'
               AND COLUMN_NAME = 'movement_type' AND COLUMN_TYPE NOT LIKE '%''return''%');
SET @sql = IF(@col > 0,
  "ALTER TABLE cf_stock_movements MODIFY COLUMN movement_type ENUM('receipt','issue','transfer','adjustment','scrap','return') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND COLUMN_NAME = 'return_kg');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_movements ADD COLUMN return_kg DECIMAL(14,3) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements' AND INDEX_NAME = 'idx_csm_order');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_stock_movements ADD KEY idx_csm_order (company_id, order_id, movement_type)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 35d. The weighted average of loose stock, per item and owner ---------------
-- One row per item that has ever had a costed movement of loose stock.
-- owner_party_id is NULL (ours) today — customer material is always a lot — and
-- is in the key so a customer pool can come later without a migration.
CREATE TABLE IF NOT EXISTS cf_item_costs (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  item_id         INT            NOT NULL,
  owner_party_id  INT            NULL,
  avg_unit_cost   DECIMAL(18,4)  NULL,            -- NULL until the first costed receipt
  costed_qty      DECIMAL(18,6)  NOT NULL DEFAULT 0,  -- the quantity the average covers
  currency        CHAR(3)        NOT NULL DEFAULT 'INR',
  last_movement_id INT           NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  owner_key       INT            GENERATED ALWAYS AS (IFNULL(owner_party_id, 0)) VIRTUAL,

  UNIQUE KEY uq_cic_tenant (company_id, id),
  UNIQUE KEY uq_cic_item   (company_id, item_id, owner_key),

  CONSTRAINT fk_cic_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cic_item     FOREIGN KEY (company_id, item_id)        REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cic_owner    FOREIGN KEY (company_id, owner_party_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_cic_movement FOREIGN KEY (company_id, last_movement_id) REFERENCES cf_stock_movements(company_id, id)
);

-- ---- 35e. Plate lots and offcuts: whose plate, and offcuts handed back ----------
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'owner_party_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_plate_lots ADD COLUMN owner_party_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND CONSTRAINT_NAME = 'fk_cpl_owner');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_plate_lots ADD CONSTRAINT fk_cpl_owner FOREIGN KEY (company_id, owner_party_id) REFERENCES cf_parties(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND COLUMN_NAME = 'owner_party_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_offcuts ADD COLUMN owner_party_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND COLUMN_NAME = 'returned_movement_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_offcuts ADD COLUMN returned_movement_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts'
               AND COLUMN_NAME = 'status' AND COLUMN_TYPE NOT LIKE '%''returned''%');
SET @sql = IF(@col > 0,
  "ALTER TABLE cf_offcuts MODIFY COLUMN status ENUM('planned','available','used','scrapped','returned') NOT NULL DEFAULT 'planned'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND INDEX_NAME = 'idx_cofc_owner');
SET @sql = IF(@idx = 0, 'ALTER TABLE cf_offcuts ADD KEY idx_cofc_owner (company_id, owner_party_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND CONSTRAINT_NAME = 'fk_cofc_owner');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_offcuts ADD CONSTRAINT fk_cofc_owner FOREIGN KEY (company_id, owner_party_id) REFERENCES cf_parties(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND CONSTRAINT_NAME = 'fk_cofc_returned');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_offcuts ADD CONSTRAINT fk_cofc_returned FOREIGN KEY (company_id, returned_movement_id) REFERENCES cf_stock_movements(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 36. PRICES — list price, sales rate, purchase unit price (CF_ERP_MONEY_PLAN §3)
-- ===========================================================================
--
-- Decided 2026-09-30. A catalog item has a LIST price, a sales order line a RATE
-- (default: the item's list price), a purchase order line a UNIT PRICE (default:
-- the last price paid for the item). A list price and a rate are quoted per a
-- BASIS — unit, kg, tonne or metre; per kg/tonne multiplies by the item's WEIGHT
-- (on an order root, the roll-up of its structure), per metre by its LENGTH.
-- AMOUNTS AND TOTALS ARE WORKED OUT ON READ (services/priceService.js), never
-- stored: they follow from price x quantity x weight, and a stored amount would
-- go stale when a roll-up changed. Every price is NET OF TAX (GST comes later
-- and sits on top). Currency is INR only for now; the column lets another come
-- later without a migration. Money: DECIMAL(18,4) unit prices.
--
-- Plain columns, no keys, each ADD guarded on its own (TiDB: never a key in the
-- same ALTER as its column; re-running is a no-op).

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND COLUMN_NAME = 'unit_price');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_purchase_order_lines ADD COLUMN unit_price DECIMAL(18,4) NULL COMMENT 'net of tax, per the line uom'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND COLUMN_NAME = 'currency');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_purchase_order_lines ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'rate');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_sales_order_lines ADD COLUMN rate DECIMAL(18,4) NULL COMMENT 'net of tax, per rate_basis'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'rate_basis');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_sales_order_lines ADD COLUMN rate_basis ENUM('unit','kg','tonne','metre') NOT NULL DEFAULT 'unit'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'currency');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_sales_order_lines ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'list_price');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_item_details ADD COLUMN list_price DECIMAL(18,4) NULL COMMENT 'net of tax, per price_basis'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'price_basis');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_item_details ADD COLUMN price_basis ENUM('unit','kg','tonne','metre') NOT NULL DEFAULT 'unit'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'currency');
SET @sql = IF(@col = 0,
  "ALTER TABLE cf_item_details ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'INR'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 37. GST — tax identity, tax on orders, one tax invoice per dispatch
--     (TM/CF_ERP_GST_PLAN.md; services/taxService.js, services/invoiceService.js)
-- ===========================================================================
--
-- Decided 2026-09-30 (user): a customer gets a TAX INVOICE WITH EACH DISPATCH,
-- and the ERP works out the tax, prints the invoice and makes the files for the
-- government portals (e-invoice JSON, e-way bill JSON) for upload by hand.
-- Defaults (Claude): RATES ARE DATA — the company's list (gst_rates JSON, NULL =
-- the seed list in taxService) and each item's rate; nothing in the logic names
-- a rate. Every existing price stays NET of tax; tax is computed on top, on read,
-- for orders and purchase orders. An INVOICE is numbered only when ISSUED and
-- never changes after: its supplier / buyer / ship-to and every line are frozen
-- into its own columns at issue (a draft is worked out live). Cancel keeps the
-- number. Numbers are gap-free per company per financial year (Apr-Mar): taken
-- inside the issuing transaction with SELECT ... FOR UPDATE on cf_invoice_series.
--
-- The party half (GSTIN = cf_parties.tax_number, registration, state, ship-to
-- addresses) is in modules/parties/models/init.sql, which runs first.
--
-- Every ADD is guarded on its own; no key is added in the ALTER that adds its
-- column (TiDB). New tables carry their keys in their CREATE.

-- ---- 37a. The company's tax identity (one row per company, §33) ---------------
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'legal_name');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN legal_name VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'trade_name');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN trade_name VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'gstin');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN gstin VARCHAR(15) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'state_code');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN state_code CHAR(2) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'address_line1');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN address_line1 VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'address_line2');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN address_line2 VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'city');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN city VARCHAR(100) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'pincode');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN pincode VARCHAR(10) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'lut_number');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN lut_number VARCHAR(50) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'invoice_prefix');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN invoice_prefix VARCHAR(8) NOT NULL DEFAULT 'INV'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'einvoice_required');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN einvoice_required TINYINT(1) NOT NULL DEFAULT 1", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'gst_rates');
SET @sql = IF(@col = 0, "ALTER TABLE cf_company_settings ADD COLUMN gst_rates JSON NULL COMMENT 'the allowed GST rates; NULL = the seed list'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 37b. HSN / SAC and GST rate on items and on template definitions --------
-- A custom line sells a temporary item whose template carries them (KEPL span ->
-- 7308, 18%): the item's own value wins, then its source definition's. NULL
-- rate = "no GST rate": a draft invoice can hold it, issue cannot.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'hsn_code');
SET @sql = IF(@col = 0, "ALTER TABLE cf_item_details ADD COLUMN hsn_code VARCHAR(8) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'gst_rate');
SET @sql = IF(@col = 0, "ALTER TABLE cf_item_details ADD COLUMN gst_rate DECIMAL(5,2) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_item_details' AND COLUMN_NAME = 'is_service');
SET @sql = IF(@col = 0, "ALTER TABLE cf_item_details ADD COLUMN is_service TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_definition_details' AND COLUMN_NAME = 'hsn_code');
SET @sql = IF(@col = 0, "ALTER TABLE cf_definition_details ADD COLUMN hsn_code VARCHAR(8) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_definition_details' AND COLUMN_NAME = 'gst_rate');
SET @sql = IF(@col = 0, "ALTER TABLE cf_definition_details ADD COLUMN gst_rate DECIMAL(5,2) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_definition_details' AND COLUMN_NAME = 'is_service');
SET @sql = IF(@col = 0, "ALTER TABLE cf_definition_details ADD COLUMN is_service TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 37c. Reverse charge on a purchase order ------------------------------------
-- The tax is payable by us, not part of the supplier's total.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND COLUMN_NAME = 'reverse_charge');
SET @sql = IF(@col = 0, "ALTER TABLE cf_purchase_orders ADD COLUMN reverse_charge TINYINT(1) NOT NULL DEFAULT 0", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---- 37d. The invoice number series, per company per financial year ----------
-- Numbers are <prefix>/<yy-yy>/<0001> (16 characters at most, the portal limit).
-- The prefix is fixed for the year at its first issue. next_no only moves inside
-- an issuing transaction that holds this row FOR UPDATE, so it never skips.
CREATE TABLE IF NOT EXISTS cf_invoice_series (
  company_id   INT          NOT NULL,
  fy           VARCHAR(7)   NOT NULL,                -- '2026-27'
  prefix       VARCHAR(8)   NOT NULL,
  next_no      INT          NOT NULL DEFAULT 1,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (company_id, fy),
  CONSTRAINT fk_cins_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- ---- 37e. Invoices -------------------------------------------------------------
-- One DRAFT per order per dispatch day collects what ships that day
-- (dispatch_date). supplier / buyer / ship_to are JSON snapshots written at
-- ISSUE, and the totals too. irn / ack / signed_qr are typed back from the IRP.
CREATE TABLE IF NOT EXISTS cf_invoices (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  company_id          INT            NOT NULL,
  order_id            INT            NOT NULL,
  customer_id         INT            NULL,
  status              ENUM('draft','issued','cancelled') NOT NULL DEFAULT 'draft',
  invoice_no          VARCHAR(16)    NULL,           -- NULL until issued
  invoice_date        DATE           NULL,
  dispatch_date       DATE           NULL,           -- the day this draft collects shipments for
  fy                  VARCHAR(7)     NULL,
  supplier            JSON           NULL,
  buyer               JSON           NULL,
  ship_to             JSON           NULL,           -- typed on a draft, or the snapshot at issue
  ship_to_address_id  INT            NULL,
  place_of_supply     CHAR(2)        NULL,
  is_igst             TINYINT(1)     NULL,
  supply_type         VARCHAR(10)    NULL,           -- B2B, SEZWP, SEZWOP, EXPWP, EXPWOP, B2C
  lut_number          VARCHAR(50)    NULL,
  reverse_charge      TINYINT(1)     NOT NULL DEFAULT 0,
  taxable_total       DECIMAL(18,2)  NULL,
  cgst_total          DECIMAL(18,2)  NULL,
  sgst_total          DECIMAL(18,2)  NULL,
  igst_total          DECIMAL(18,2)  NULL,
  round_off           DECIMAL(8,2)   NULL,
  grand_total         DECIMAL(18,2)  NULL,
  currency            CHAR(3)        NOT NULL DEFAULT 'INR',
  irn                 VARCHAR(64)    NULL,
  ack_no              VARCHAR(20)    NULL,
  ack_date            DATETIME       NULL,
  signed_qr           TEXT           NULL,
  transport           JSON           NULL,
  notes               TEXT           NULL,
  cancelled_reason    VARCHAR(255)   NULL,
  cancelled_at        DATETIME       NULL,
  cancelled_by        INT            NULL,
  issued_at           DATETIME       NULL,
  issued_by           INT            NULL,

  deleted_at          DATETIME       DEFAULT NULL,   -- drafts only; an issued invoice is never deleted
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT            NULL,

  UNIQUE KEY uq_cinv_tenant (company_id, id),
  UNIQUE KEY uq_cinv_no     (company_id, invoice_no),
  KEY idx_cinv_order    (company_id, order_id, status),
  KEY idx_cinv_customer (company_id, customer_id),
  KEY idx_cinv_status   (company_id, status, invoice_date),

  CONSTRAINT fk_cinv_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cinv_order     FOREIGN KEY (company_id, order_id)    REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_cinv_customer  FOREIGN KEY (company_id, customer_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_cinv_ship_to   FOREIGN KEY (company_id, ship_to_address_id) REFERENCES cf_party_addresses(company_id, id),
  CONSTRAINT fk_cinv_creator   FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_cinv_issuer    FOREIGN KEY (issued_by)    REFERENCES users(id),
  CONSTRAINT fk_cinv_canceller FOREIGN KEY (cancelled_by) REFERENCES users(id)
);

-- ---- 37f. Invoice lines — one per shipment (movement) of an order line ----------
-- A draft line holds only WHAT shipped (order line, movement, quantity); its
-- money is worked out live. Issue writes every other column. claim = 1 while
-- the line holds its shipment (a live line on a draft or issued invoice); a
-- removed line or a cancelled invoice sets it NULL, so uq_cinl_claim lets a
-- shipment be invoiced AT MOST ONCE and a cancel frees it.
CREATE TABLE IF NOT EXISTS cf_invoice_lines (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  invoice_id      INT            NOT NULL,
  line_no         INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  movement_id     INT            NOT NULL,
  claim           TINYINT        NULL DEFAULT 1,
  quantity        DECIMAL(18,6)  NOT NULL,          -- in the line item's unit, as shipped
  description     VARCHAR(500)   NULL,
  hsn_code        VARCHAR(8)     NULL,
  is_service      TINYINT(1)     NULL,
  uom             VARCHAR(20)    NULL,
  billed_qty      DECIMAL(18,6)  NULL,
  billed_uom      VARCHAR(10)    NULL,
  rate            DECIMAL(18,4)  NULL,
  rate_basis      ENUM('unit','kg','tonne','metre') NULL,
  taxable         DECIMAL(18,2)  NULL,
  gst_rate        DECIMAL(5,2)   NULL,
  cgst            DECIMAL(18,2)  NULL,
  sgst            DECIMAL(18,2)  NULL,
  igst            DECIMAL(18,2)  NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cinl_tenant (company_id, id),
  UNIQUE KEY uq_cinl_claim  (company_id, movement_id, order_line_id, claim),
  KEY idx_cinl_invoice    (company_id, invoice_id),
  KEY idx_cinl_order_line (company_id, order_line_id),

  CONSTRAINT fk_cinl_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cinl_invoice    FOREIGN KEY (company_id, invoice_id)    REFERENCES cf_invoices(company_id, id),
  CONSTRAINT fk_cinl_order_line FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cinl_movement   FOREIGN KEY (company_id, movement_id)   REFERENCES cf_stock_movements(company_id, id)
);

-- ---- 37g. E-way bills — a big structure can need several vehicles --------------
CREATE TABLE IF NOT EXISTS cf_eway_bills (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  invoice_id   INT           NOT NULL,
  eway_no      VARCHAR(12)   NOT NULL,
  vehicle_no   VARCHAR(20)   NULL,
  valid_until  DATETIME      NULL,

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  eway_active  VARCHAR(12)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, eway_no, NULL)) VIRTUAL,

  UNIQUE KEY uq_cewb_tenant (company_id, id),
  UNIQUE KEY uq_cewb_no     (company_id, eway_active),
  KEY idx_cewb_invoice (company_id, invoice_id),

  CONSTRAINT fk_cewb_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cewb_invoice FOREIGN KEY (company_id, invoice_id) REFERENCES cf_invoices(company_id, id),
  CONSTRAINT fk_cewb_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ===========================================================================
-- 38. PLANNER RANKS — the order of a line's units, dragged by hand
-- ===========================================================================
--
-- 2026-10-01, the planner rework (the user: "make it very easy to expand, drag
-- and drop and shift things around"). Orders are ranked by
-- cf_sales_orders.plan_priority (§31) and lines go in line order; INSIDE a line
-- the planner's units (girder lines, segments, lots) used to go in structure
-- order. Dragging a unit up or down the plan's tree now stores that order here:
-- rank_no 1 = first. Auto-plan and material allocation take a line's ranked
-- units first, in rank order, then the rest in structure order.
-- Written as a whole line at a time (PUT /planner/changes { ranks: [{ lineId,
-- unitKeys }] }): the line's rows are deleted and re-inserted, so there is no
-- soft delete. unit_key is the planner's key ('p<piece>' | 'l<line>' |
-- 'g<parent piece>.<bom line>'), as cf_plan_entries.
CREATE TABLE IF NOT EXISTS cf_plan_ranks (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  unit_key        VARCHAR(40)    NOT NULL,
  rank_no         INT            NOT NULL,
  updated_by      INT            NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cprk_unit (company_id, unit_key),
  KEY idx_cprk_line (company_id, order_line_id),

  CONSTRAINT fk_cprk_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cprk_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cprk_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- ===========================================================================
-- 39. PROCUREMENT — purchase request -> RFQ -> quotes -> comparison -> award -> POs
-- ===========================================================================
--
-- TM/CF_ERP_PROCUREMENT_PLAN.md (decided 2026-10-01). User: a purchase request
-- needs ONE approver before it can go for quotes; an RFQ goes out as a document
-- per supplier (print + a ready email the buyer sends from their own mail) and
-- quotes are TYPED in by the buyer. Compare and award PER LINE; prices are net of
-- tax; only POs count as "on order" — request / RFQ lines show as "in request" /
-- "in RFQ" on the buy list so nothing is raised twice.
--
-- A request line's status is the lock that keeps it in ONE open RFQ at a time:
-- open (in a draft / submitted / approved request, not in an RFQ) -> in_rfq ->
-- ordered (on a PO) | cancelled. Closing or cancelling an RFQ puts its
-- un-ordered request lines back to open.
--
-- New tables carry their keys in their CREATE; every ADD on an existing table is
-- guarded on its own and no key is added in the ALTER that adds its column (TiDB).

CREATE TABLE IF NOT EXISTS cf_purchase_requests (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  code            VARCHAR(100)  NULL,               -- NULL only between the insert and the PR-000123 fallback
  status          ENUM('draft','submitted','approved','rejected','closed','cancelled') NOT NULL DEFAULT 'draft',
  needed_by       DATE          NULL,
  notes           TEXT          NULL,
  requested_by    INT           NULL,
  submitted_at    DATETIME      NULL,
  decided_by      INT           NULL,
  decided_at      DATETIME      NULL,
  decision_note   VARCHAR(500)  NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  code_active     VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_cprq_tenant (company_id, id),
  UNIQUE KEY uq_cprq_code   (company_id, code_active),
  KEY idx_cprq_status (company_id, status),

  CONSTRAINT fk_cprq_company   FOREIGN KEY (company_id)   REFERENCES companies(id),
  CONSTRAINT fk_cprq_requester FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_cprq_decider   FOREIGN KEY (decided_by)   REFERENCES users(id),
  CONSTRAINT fk_cprq_creator   FOREIGN KEY (created_by)   REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_purchase_request_lines (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  request_id      INT            NOT NULL,
  line_no         INT            NOT NULL,
  item_id         INT            NOT NULL,
  quantity        DECIMAL(18,6)  NOT NULL,
  uom             VARCHAR(20)    NOT NULL DEFAULT 'nos',
  needed_by       DATE           NULL,
  est_unit_price  DECIMAL(18,4)  NULL,
  source          JSON           NULL,             -- the buy-list row it came from: { from, planned, orders, lines }
  status          ENUM('open','in_rfq','ordered','cancelled') NOT NULL DEFAULT 'open',
  notes           VARCHAR(500)   NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cprql_tenant (company_id, id),
  KEY idx_cprql_request (company_id, request_id, line_no),
  KEY idx_cprql_item    (company_id, item_id, status),

  CONSTRAINT fk_cprql_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cprql_request FOREIGN KEY (company_id, request_id) REFERENCES cf_purchase_requests(company_id, id),
  CONSTRAINT fk_cprql_item    FOREIGN KEY (company_id, item_id)    REFERENCES cf_item_details(company_id, master_id)
);

-- Who did what to a request, and when (created, submitted, approved, rejected,
-- cancelled, closed). A rejected request can be edited and submitted again, so
-- the decision columns alone would lose the first answer.
CREATE TABLE IF NOT EXISTS cf_purchase_request_events (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  request_id      INT            NOT NULL,
  action          VARCHAR(20)    NOT NULL,
  note            VARCHAR(500)   NULL,
  user_id         INT            NULL,
  created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP,

  KEY idx_cpre_request (company_id, request_id, id),

  CONSTRAINT fk_cpre_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpre_request FOREIGN KEY (company_id, request_id) REFERENCES cf_purchase_requests(company_id, id),
  CONSTRAINT fk_cpre_user    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cf_rfqs (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  code            VARCHAR(100)  NULL,
  status          ENUM('draft','sent','closed','awarded','cancelled') NOT NULL DEFAULT 'draft',
  quotes_due      DATE          NULL,
  terms           TEXT          NULL,
  notes           TEXT          NULL,
  created_by      INT           NULL,
  sent_at         DATETIME      NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  code_active     VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_crfq_tenant (company_id, id),
  UNIQUE KEY uq_crfq_code   (company_id, code_active),
  KEY idx_crfq_status (company_id, status),

  CONSTRAINT fk_crfq_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_crfq_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- purchase_line_id: the PO line the awarded line went onto (set by create-pos).
-- A PO holds one line per item (uq_cpol_item), so two RFQ lines of the same item
-- awarded to one supplier share one PO line; this column keeps both traceable.
CREATE TABLE IF NOT EXISTS cf_rfq_lines (
  id                     INT            AUTO_INCREMENT PRIMARY KEY,
  company_id             INT            NOT NULL,
  rfq_id                 INT            NOT NULL,
  line_no                INT            NOT NULL,
  request_line_id        INT            NULL,
  item_id                INT            NOT NULL,
  quantity               DECIMAL(18,6)  NOT NULL,
  uom                    VARCHAR(20)    NOT NULL DEFAULT 'nos',
  needed_by              DATE           NULL,
  awarded_quote_line_id  INT            NULL,
  purchase_line_id       INT            NULL,

  deleted_at             DATETIME       DEFAULT NULL,
  created_at             TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_crfl_tenant (company_id, id),
  KEY idx_crfl_rfq     (company_id, rfq_id, line_no),
  KEY idx_crfl_request (company_id, request_line_id),
  KEY idx_crfl_item    (company_id, item_id),

  CONSTRAINT fk_crfl_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_crfl_rfq      FOREIGN KEY (company_id, rfq_id)           REFERENCES cf_rfqs(company_id, id),
  CONSTRAINT fk_crfl_request  FOREIGN KEY (company_id, request_line_id)  REFERENCES cf_purchase_request_lines(company_id, id),
  CONSTRAINT fk_crfl_item     FOREIGN KEY (company_id, item_id)          REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_crfl_po_line  FOREIGN KEY (company_id, purchase_line_id) REFERENCES cf_purchase_order_lines(company_id, id)
);

CREATE TABLE IF NOT EXISTS cf_rfq_suppliers (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  rfq_id          INT           NOT NULL,
  supplier_id     INT           NOT NULL,
  status          ENUM('invited','sent','quoted','declined') NOT NULL DEFAULT 'invited',
  sent_at         DATETIME      NULL,
  contact_email   VARCHAR(255)  NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_crfs_tenant   (company_id, id),
  UNIQUE KEY uq_crfs_supplier (rfq_id, supplier_id),
  KEY idx_crfs_rfq (company_id, rfq_id),

  CONSTRAINT fk_crfs_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_crfs_rfq      FOREIGN KEY (company_id, rfq_id)      REFERENCES cf_rfqs(company_id, id),
  CONSTRAINT fk_crfs_supplier FOREIGN KEY (company_id, supplier_id) REFERENCES cf_parties(company_id, id)
);

-- One live quote per supplier per RFQ: entering it again UPDATES it (upsert).
CREATE TABLE IF NOT EXISTS cf_quotes (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  rfq_id          INT            NOT NULL,
  supplier_id     INT            NOT NULL,
  quote_ref       VARCHAR(100)   NULL,
  received_on     DATE           NULL,
  valid_until     DATE           NULL,
  payment_terms   VARCHAR(255)   NULL,
  freight_amount  DECIMAL(18,2)  NULL,
  currency        CHAR(3)        NOT NULL DEFAULT 'INR',
  notes           TEXT           NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  supplier_live   INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, supplier_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_cqt_tenant   (company_id, id),
  UNIQUE KEY uq_cqt_supplier (rfq_id, supplier_live),
  KEY idx_cqt_rfq (company_id, rfq_id),

  CONSTRAINT fk_cqt_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cqt_rfq      FOREIGN KEY (company_id, rfq_id)      REFERENCES cf_rfqs(company_id, id),
  CONSTRAINT fk_cqt_supplier FOREIGN KEY (company_id, supplier_id) REFERENCES cf_parties(company_id, id),
  CONSTRAINT fk_cqt_creator  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- unit_price NULL = not quoted. Updated in place (uq_cqtl_line), never
-- delete-and-insert: an award and a PO line point at the row's id.
CREATE TABLE IF NOT EXISTS cf_quote_lines (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  quote_id        INT            NOT NULL,
  rfq_line_id     INT            NOT NULL,
  unit_price      DECIMAL(18,4)  NULL,
  gst_rate        DECIMAL(5,2)   NULL,
  lead_time_days  INT            NULL,
  qty_offered     DECIMAL(18,6)  NULL,
  remark          VARCHAR(500)   NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cqtl_tenant (company_id, id),
  UNIQUE KEY uq_cqtl_line   (quote_id, rfq_line_id),
  KEY idx_cqtl_rfq_line (company_id, rfq_line_id),

  CONSTRAINT fk_cqtl_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cqtl_quote    FOREIGN KEY (company_id, quote_id)    REFERENCES cf_quotes(company_id, id),
  CONSTRAINT fk_cqtl_rfq_line FOREIGN KEY (company_id, rfq_line_id) REFERENCES cf_rfq_lines(company_id, id)
);

-- The award points at a quote line; cf_quote_lines is created after cf_rfq_lines,
-- so this foreign key comes afterwards, guarded.
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_rfq_lines' AND CONSTRAINT_NAME = 'fk_crfl_award');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_rfq_lines ADD CONSTRAINT fk_crfl_award FOREIGN KEY (company_id, awarded_quote_line_id) REFERENCES cf_quote_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Traceability on the purchase order line: the quote line it was priced from and
-- the request line it buys. Columns first, keys in their own ALTERs (TiDB).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND COLUMN_NAME = 'quote_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_purchase_order_lines ADD COLUMN quote_line_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND COLUMN_NAME = 'request_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_purchase_order_lines ADD COLUMN request_line_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND INDEX_NAME = 'idx_cpol_quote_line');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_purchase_order_lines ADD KEY idx_cpol_quote_line (company_id, quote_line_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND INDEX_NAME = 'idx_cpol_request_line');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_purchase_order_lines ADD KEY idx_cpol_request_line (company_id, request_line_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND CONSTRAINT_NAME = 'fk_cpol_quote_line');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_purchase_order_lines ADD CONSTRAINT fk_cpol_quote_line FOREIGN KEY (company_id, quote_line_id) REFERENCES cf_quote_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_order_lines' AND CONSTRAINT_NAME = 'fk_cpol_request_line');
SET @sql = IF(@fk = 0,
  'ALTER TABLE cf_purchase_order_lines ADD CONSTRAINT fk_cpol_request_line FOREIGN KEY (company_id, request_line_id) REFERENCES cf_purchase_request_lines(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The approve permission (approve / reject purchase requests): a feature, its
-- capability, and a grant (§32 style) to every role / team / company that holds
-- a capability CONTAINING purchase manage (cf_erp_inventory_manage — buying runs
-- on it), for the same app. models/seed.sql lists it for a fresh database's admin.
INSERT INTO features (feature_name, feature_tag, type)
SELECT 'CF ERP: approve purchase requests', 'cf_erp_purchase_approve', 'backend'
 WHERE NOT EXISTS (SELECT 1 FROM features f WHERE f.feature_tag = 'cf_erp_purchase_approve' AND f.deleted_at IS NULL);

INSERT INTO features_capability (name, features_json)
SELECT f.feature_tag, JSON_ARRAY(f.id)
  FROM features f
 WHERE f.feature_tag = 'cf_erp_purchase_approve' AND f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM features_capability fc WHERE fc.name = 'cf_erp_purchase_approve' AND fc.deleted_at IS NULL);

INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT DISTINCT rc.role_id, rc.team_id, rc.company_id, rc.app_id, pa.capability_id
  FROM role_capability rc
  JOIN features_capability im ON im.capability_id = rc.capability_id AND im.deleted_at IS NULL
  JOIN features imf ON imf.feature_tag = 'cf_erp_inventory_manage' AND imf.deleted_at IS NULL
                   AND JSON_CONTAINS(im.features_json, CAST(imf.id AS JSON))
  JOIN features_capability pa ON pa.name = 'cf_erp_purchase_approve' AND pa.deleted_at IS NULL
 WHERE rc.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability x
      WHERE x.capability_id = pa.capability_id AND x.deleted_at IS NULL
        AND x.role_id <=> rc.role_id AND x.team_id <=> rc.team_id
        AND x.company_id <=> rc.company_id AND x.app_id <=> rc.app_id);

-- ===========================================================================
-- 40. NESTING CHOICES — the cut pieces and raw plates a line's nesting leaves out
-- ===========================================================================
--
-- 2026-10-02 (the user: "before any nesting is done, show the cut pieces and let
-- the user remove any … then show the list of RMs you will consider based on the
-- thickness of the cut plates; let the user unselect any"). One row per thing
-- left out of a line's AUTOMATIC nesting:
--   kind 'cut_plate'  a cut piece (blank) taken out of every run on this line;
--                     it stays "plate chosen at nesting" — nest it later, or
--                     choose its plate by hand. Like NEST_MANUAL, but per line
--                     and without touching the cut piece's values.
--   kind 'plate'      a catalog raw plate the packer may not draw on for this
--                     line (it is still a candidate everywhere else).
-- Applied by every plan (Quick / Standard / Deep, re-nest) and checked again by
-- accept. Written as a whole line at a time (PUT …/nesting/choices): the line's
-- rows are deleted and re-inserted, so there is no soft delete (as §38). A row
-- whose item is no longer a cut piece / candidate of the line is ignored.
CREATE TABLE IF NOT EXISTS cf_nest_exclusions (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  order_line_id   INT            NOT NULL,
  kind            ENUM('cut_plate','plate') NOT NULL,
  item_id         INT            NOT NULL,
  created_by      INT            NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_cnex_item (company_id, order_line_id, kind, item_id),
  KEY idx_cnex_line (company_id, order_line_id),

  CONSTRAINT fk_cnex_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cnex_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cnex_item    FOREIGN KEY (item_id) REFERENCES cf_master_records(id),
  CONSTRAINT fk_cnex_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ===========================================================================
-- 41. CLASSIFICATION BY SCREEN — which screen's pop-up made a node
-- ===========================================================================
--
-- 2026-10-02 (the user: classification is managed from the screens that use it,
-- and NO hand tagging — "tags are error-prone"). What a screen shows is derived:
-- Items shows the branches that hold items, Definitions the ones that hold
-- definitions (plus every branch a selection picks from), Machines the machine
-- families. Only an EMPTY node has nothing to derive from, so it shows on the
-- screen whose pop-up created it — stamped here, automatically, at creation.
-- NULL = made before this column (or by a script): shown on Items and on
-- Definitions so nothing is lost. 'setup' = made by the old Setup screen or the
-- command palette; read like NULL. Never written after the insert.
-- VARCHAR, not ENUM: TiDB only lets an ENUM grow at the end, and a new screen
-- should not need a schema change.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_classification_nodes' AND COLUMN_NAME = 'created_in');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_classification_nodes ADD COLUMN created_in VARCHAR(16) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ===========================================================================
-- 42. WHAT A SELECTION PICKS FROM — a list of branches and items (and the
--     row a person has not chosen yet)
-- ===========================================================================
--
-- 2026-10-02 (agreed with the user). A selection used to choose from ONE
-- optional classification node, OR an allowed list, OR both (intersected),
-- with a mode switch saying which. Now it picks from a LIST OF ENTRIES:
--   node_id  a classification node at ANY level — its whole subtree
--   item_id  one catalog item (is_default = the starred default, at most one)
-- Candidates = the UNION of the entries, then narrowed by the spec filters
-- (cf_selection_criteria, unchanged: same spec OR, different specs AND).
-- Exactly one of node_id / item_id per row (service rule). Hard-deleted, like
-- §40: a removed entry has no history worth keeping.
--
-- The old columns stay and are KEPT IN STEP by selectionService (syncLegacy):
-- cf_definition_details.candidate_classification_id = the first node entry
-- (cut plates still find "the selection that searches PLATE" by it),
-- selection_mode derived (items only = allowed_list, nodes only = spec_match,
-- both = both — now meaning union), cf_definition_allowed_items = the item
-- entries. That is also what keeps the migration below idempotent: it only
-- fills a selection that has NO entry yet, and a selection emptied through
-- the new code has nothing left in the old columns to be filled from.
CREATE TABLE IF NOT EXISTS cf_selection_scope (
  id             INT        AUTO_INCREMENT PRIMARY KEY,
  company_id     INT        NOT NULL,
  definition_id  INT        NOT NULL,              -- a selection definition
  node_id        INT        NULL,                  -- a classification node (its subtree)
  item_id        INT        NULL,                  -- or one catalog item
  is_default     TINYINT(1) NOT NULL DEFAULT 0,    -- item entries only
  sort_order     INT        NOT NULL DEFAULT 0,
  created_by     INT        NULL,
  created_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,

  KEY idx_cssc_def  (company_id, definition_id),
  KEY idx_cssc_node (company_id, node_id),
  KEY idx_cssc_item (company_id, item_id),

  CONSTRAINT fk_cssc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cssc_def     FOREIGN KEY (company_id, definition_id) REFERENCES cf_definition_details(company_id, master_id),
  CONSTRAINT fk_cssc_node    FOREIGN KEY (company_id, node_id)       REFERENCES cf_classification_nodes(company_id, id),
  CONSTRAINT fk_cssc_item    FOREIGN KEY (company_id, item_id)       REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cssc_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Migration, the narrowest faithful translation of the old rule:
--   spec_match + node        -> the node entry (criteria unchanged)
--   spec_match, no node      -> one entry per top-level item branch (the old
--                               "whole catalog"), so nothing is lost
--   allowed_list (or NULL)   -> the item entries (an old node was ignored)
--   both, no node            -> the item entries (items ∩ criteria = old rule)
--   both + node              -> ONLY the item entries that lie inside the node
--                               (old = items ∩ node ∩ criteria; a node entry
--                               would WIDEN it to the whole branch)
-- Each statement fills only a selection that has no entry at all.
INSERT INTO cf_selection_scope (company_id, definition_id, node_id, item_id, is_default, sort_order)
SELECT d.company_id, d.master_id, d.candidate_classification_id, NULL, 0, 0
  FROM cf_definition_details d
  JOIN cf_master_records m ON m.company_id = d.company_id AND m.id = d.master_id AND m.deleted_at IS NULL
 WHERE d.deleted_at IS NULL AND d.definition_type = 'selection' AND d.selection_mode = 'spec_match'
   AND d.candidate_classification_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM cf_selection_scope s WHERE s.company_id = d.company_id AND s.definition_id = d.master_id);

INSERT INTO cf_selection_scope (company_id, definition_id, node_id, item_id, is_default, sort_order)
SELECT d.company_id, d.master_id, n.id, NULL, 0, n.sort_order
  FROM cf_definition_details d
  JOIN cf_master_records m ON m.company_id = d.company_id AND m.id = d.master_id AND m.deleted_at IS NULL
  JOIN cf_classification_nodes n ON n.company_id = d.company_id AND n.parent_id IS NULL AND n.deleted_at IS NULL AND n.scope <> 'machine'
 WHERE d.deleted_at IS NULL AND d.definition_type = 'selection' AND d.selection_mode = 'spec_match'
   AND d.candidate_classification_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM cf_selection_scope s WHERE s.company_id = d.company_id AND s.definition_id = d.master_id);

-- Items: allowed_list / NULL / both. For 'both' with a node the item's own
-- branch must be the node or below it (at most four levels up — the tree has
-- three; a self-join chain rather than a recursive CTE inside an INSERT).
INSERT INTO cf_selection_scope (company_id, definition_id, node_id, item_id, is_default, sort_order)
SELECT a.company_id, a.definition_id, NULL, a.item_id, a.is_default, a.sort_order
  FROM cf_definition_allowed_items a
  JOIN cf_definition_details d ON d.company_id = a.company_id AND d.master_id = a.definition_id AND d.deleted_at IS NULL
  JOIN cf_master_records m ON m.company_id = d.company_id AND m.id = d.master_id AND m.deleted_at IS NULL
  JOIN cf_master_records i ON i.company_id = a.company_id AND i.id = a.item_id AND i.deleted_at IS NULL
  LEFT JOIN cf_classification_nodes p1 ON p1.company_id = i.company_id AND p1.id = i.classification_id
  LEFT JOIN cf_classification_nodes p2 ON p2.company_id = p1.company_id AND p2.id = p1.parent_id
  LEFT JOIN cf_classification_nodes p3 ON p3.company_id = p2.company_id AND p3.id = p2.parent_id
  LEFT JOIN cf_classification_nodes p4 ON p4.company_id = p3.company_id AND p4.id = p3.parent_id
 WHERE a.deleted_at IS NULL AND d.definition_type = 'selection'
   AND (d.selection_mode IS NULL OR d.selection_mode IN ('allowed_list', 'both'))
   AND (d.selection_mode IS NULL OR d.selection_mode = 'allowed_list' OR d.candidate_classification_id IS NULL
        OR d.candidate_classification_id IN (p1.id, p2.id, p3.id, p4.id))
   AND NOT EXISTS (SELECT 1 FROM cf_selection_scope s WHERE s.company_id = a.company_id AND s.definition_id = a.definition_id AND s.node_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM cf_selection_scope s WHERE s.company_id = a.company_id AND s.definition_id = a.definition_id AND s.item_id = a.item_id);

-- A row of an order whose catalog item the SYSTEM chose for a selection (its
-- default, or its only candidate): 1 shows "default · change" on the row until
-- a person chooses (which writes 0). NULL/0 = chosen by a person, or never a
-- selection. No key (TiDB: never ADD KEY in the same ALTER as its column).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_bom_lines' AND COLUMN_NAME = 'auto_chosen');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_bom_lines ADD COLUMN auto_chosen TINYINT(1) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §43  Purchase orders bought FOR a sales order, and what arrives held for it
-- ============================================================================
-- A PO line can be bought for one or more sales orders, each for a quantity
-- (cf_purchase_line_orders). The PO header's for_order_id is only the DEFAULT a
-- new line takes. Suggest and RFQ create-pos fill the allocations from the buy
-- list's per-order split. On receipt each allocation's share becomes a HOLD: a
-- cf_stock_reservations row with held_for_order_id + purchase_line_id and no
-- requirement_id / order_line_id, so nobody else can take it (availability
-- subtracts every active reservation). The order's release takes its own holds
-- first and turns them into requirement reservations. An order is matched by
-- its NUMBER (code_active), so a revision keeps what was held for the one before.
CREATE TABLE IF NOT EXISTS cf_purchase_line_orders (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  purchase_line_id  INT            NOT NULL,
  order_id          INT            NOT NULL,
  quantity          DECIMAL(18,6)  NOT NULL,
  qty_received      DECIMAL(18,6)  NOT NULL DEFAULT 0,

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  order_live        INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, order_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_cplo_tenant (company_id, id),
  UNIQUE KEY uq_cplo_line_order (purchase_line_id, order_live),
  KEY idx_cplo_line  (company_id, purchase_line_id),
  KEY idx_cplo_order (company_id, order_id),

  CONSTRAINT fk_cplo_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cplo_line    FOREIGN KEY (company_id, purchase_line_id) REFERENCES cf_purchase_order_lines(company_id, id),
  CONSTRAINT fk_cplo_order   FOREIGN KEY (company_id, order_id) REFERENCES cf_sales_orders(company_id, id),
  CONSTRAINT fk_cplo_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND COLUMN_NAME = 'for_order_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_purchase_orders ADD COLUMN for_order_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND INDEX_NAME = 'idx_cpo_for_order');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_purchase_orders ADD KEY idx_cpo_for_order (company_id, for_order_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND CONSTRAINT_NAME = 'fk_cpo_for_order');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_purchase_orders ADD CONSTRAINT fk_cpo_for_order FOREIGN KEY (company_id, for_order_id) REFERENCES cf_sales_orders(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND COLUMN_NAME = 'held_for_order_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_stock_reservations ADD COLUMN held_for_order_id INT NULL, ADD COLUMN purchase_line_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND INDEX_NAME = 'idx_csrv_held');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_stock_reservations ADD KEY idx_csrv_held (company_id, held_for_order_id, status)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND CONSTRAINT_NAME = 'fk_csrv_held_order');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_stock_reservations ADD CONSTRAINT fk_csrv_held_order FOREIGN KEY (company_id, held_for_order_id) REFERENCES cf_sales_orders(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_reservations' AND CONSTRAINT_NAME = 'fk_csrv_purchase_line');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_stock_reservations ADD CONSTRAINT fk_csrv_purchase_line FOREIGN KEY (company_id, purchase_line_id) REFERENCES cf_purchase_order_lines(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §44  Which plates a line's nesting may use: standard only, or standard + custom
-- ============================================================================
-- 'standard' | 'any'; NULL = never set, read as 'any' (standard and custom —
-- the default; nestingService.requireLine). A plate says STANDARD / CUSTOM through the
-- PLATE_KIND option spec (tenant setup: scripts/cf_kepl/plate-kind-setup.mjs).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_sales_order_lines' AND COLUMN_NAME = 'nest_plates');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_sales_order_lines ADD COLUMN nest_plates VARCHAR(16) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §45  The production ledger: stock follows the steel up and down the BOM
-- ============================================================================
-- CF_ERP_WIP_LEDGER_PLAN.md. Pieces JOIN their parent when the joining step
-- STARTS; a piece SPLITS into its children when the splitting step is DONE; the
-- top piece goes to finished stock when its flow is done. Every tracker node is
-- a lot of its own (cf_stock_batches.production_item_id) in the company's ONE
-- production WIP area. A 'transform' movement carries both sides of a move:
-- what is consumed (negative legs) and what is made (positive), value conserved.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_stock_movements'
               AND COLUMN_NAME = 'movement_type' AND COLUMN_TYPE NOT LIKE '%''transform''%');
SET @sql = IF(@col > 0,
  "ALTER TABLE cf_stock_movements MODIFY COLUMN movement_type ENUM('receipt','issue','transfer','adjustment','scrap','return','transform') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- What each step has already posted, so the ledger is RECONCILED, never replayed:
-- ledger_in = quantity joined into the node when this step started; ledger_out =
-- quantity split out of it when this step was done. A correction posts the
-- difference (negative = the exact reverse).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_production_steps' AND COLUMN_NAME = 'ledger_in');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_production_steps ADD COLUMN ledger_in DECIMAL(18,6) NOT NULL DEFAULT 0, ADD COLUMN ledger_out DECIMAL(18,6) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A parent is a CONTAINER: one row per lot that joined it (a child node's lot,
-- or bought material from a requirement), with the value it brought, until it
-- leaves again (a split) — left_movement_id set.
CREATE TABLE IF NOT EXISTS cf_wip_joins (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  company_id          INT            NOT NULL,
  parent_item_id      INT            NOT NULL,        -- cf_production_items: the container
  step_id             INT            NOT NULL,        -- the step whose start joined it
  child_item_id       INT            NULL,            -- cf_production_items: a made child
  requirement_id      INT            NULL,            -- or bought material (a requirement)
  item_id             INT            NOT NULL,        -- the stock item that went in
  batch_id            INT            NULL,            -- the lot it came from (NULL = loose)
  area_id             INT            NOT NULL,        -- the area it came from (a reverse puts it back there)
  quantity            DECIMAL(18,6)  NOT NULL,
  value               DECIMAL(18,2)  NULL,
  joined_movement_id  INT            NOT NULL,
  left_movement_id    INT            NULL,
  left_step_id        INT            NULL,

  deleted_at          DATETIME       DEFAULT NULL,
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT            NULL,

  UNIQUE KEY uq_cwj_tenant (company_id, id),
  KEY idx_cwj_parent (company_id, parent_item_id),
  KEY idx_cwj_child  (company_id, child_item_id),
  KEY idx_cwj_step   (company_id, step_id),

  CONSTRAINT fk_cwj_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cwj_parent  FOREIGN KEY (company_id, parent_item_id) REFERENCES cf_production_items(company_id, id),
  CONSTRAINT fk_cwj_child   FOREIGN KEY (company_id, child_item_id)  REFERENCES cf_production_items(company_id, id),
  CONSTRAINT fk_cwj_step    FOREIGN KEY (company_id, step_id)        REFERENCES cf_production_steps(company_id, id),
  CONSTRAINT fk_cwj_req     FOREIGN KEY (company_id, requirement_id) REFERENCES cf_material_requirements(company_id, id),
  CONSTRAINT fk_cwj_item    FOREIGN KEY (company_id, item_id)        REFERENCES cf_item_details(company_id, master_id),
  CONSTRAINT fk_cwj_batch   FOREIGN KEY (company_id, batch_id)       REFERENCES cf_stock_batches(company_id, id),
  CONSTRAINT fk_cwj_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- An offcut becomes a stock piece (a lot of one) when its plate is cut.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND COLUMN_NAME = 'batch_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_offcuts ADD COLUMN batch_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND INDEX_NAME = 'idx_cofc_batch');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_offcuts ADD KEY idx_cofc_batch (company_id, batch_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND CONSTRAINT_NAME = 'fk_cofc_batch');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_offcuts ADD CONSTRAINT fk_cofc_batch FOREIGN KEY (company_id, batch_id) REFERENCES cf_stock_batches(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §46  One purchase order, stage by stage (CF_ERP_PURCHASE_FLOW_PLAN.md)
-- ============================================================================
-- requested → quoting → ordered → partially_received → received (cancelled
-- before). The RFQ lives UNDER its PO (cf_rfqs.purchase_order_id); each RFQ line
-- names the PO line it quotes for (po_line_id). stock_checked_at marks the
-- stock check done (stock held for the sales order, the PO cut to the rest).
-- TiDB will not change a column a generated column reads. suggest_live (one
-- open Suggest draft per company) read status — Suggest is gone, so the key and
-- the column go first; then the status list can grow.
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND INDEX_NAME = 'uq_cpo_suggest');
SET @sql = IF(@ix > 0, 'ALTER TABLE cf_purchase_orders DROP INDEX uq_cpo_suggest', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND COLUMN_NAME = 'suggest_live');
SET @sql = IF(@col > 0, 'ALTER TABLE cf_purchase_orders DROP COLUMN suggest_live', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders'
               AND COLUMN_NAME = 'status' AND COLUMN_TYPE NOT LIKE '%''requested''%');
SET @sql = IF(@col > 0,
  "ALTER TABLE cf_purchase_orders MODIFY COLUMN status ENUM('draft','ordered','partially_received','received','cancelled','requested','quoting') NOT NULL DEFAULT 'requested'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_purchase_orders' AND COLUMN_NAME = 'stock_checked_at');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_purchase_orders ADD COLUMN stock_checked_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_rfqs' AND COLUMN_NAME = 'purchase_order_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_rfqs ADD COLUMN purchase_order_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_rfqs' AND INDEX_NAME = 'idx_crfq_po');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_rfqs ADD KEY idx_crfq_po (company_id, purchase_order_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_rfqs' AND CONSTRAINT_NAME = 'fk_crfq_po');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_rfqs ADD CONSTRAINT fk_crfq_po FOREIGN KEY (company_id, purchase_order_id) REFERENCES cf_purchase_orders(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_rfq_lines' AND COLUMN_NAME = 'po_line_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_rfq_lines ADD COLUMN po_line_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_rfq_lines' AND INDEX_NAME = 'idx_crfl_po_line');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_rfq_lines ADD KEY idx_crfl_po_line (company_id, po_line_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The old draft PO is a requested one now (idempotent: nothing is 'draft' after).
UPDATE cf_purchase_orders SET status = 'requested' WHERE status = 'draft';

-- ============================================================================
-- §47  Planner v2: rows planned "their parts separately" (CF_ERP_PLANNER_V2_PLAN.md)
-- ============================================================================
-- Per order line: a row (bom_line_id) whose made children ship as their own
-- units instead of the row itself. The template's SHIP_UNIT stays the default.
CREATE TABLE IF NOT EXISTS cf_plan_splits (
  id             INT        AUTO_INCREMENT PRIMARY KEY,
  company_id     INT        NOT NULL,
  order_line_id  INT        NOT NULL,
  bom_line_id    INT        NOT NULL,
  deleted_at     DATETIME   DEFAULT NULL,
  created_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT        NULL,
  UNIQUE KEY uq_cpsp_tenant (company_id, id),
  UNIQUE KEY uq_cpsp_row    (company_id, order_line_id, bom_line_id),
  CONSTRAINT fk_cpsp_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cpsp_line    FOREIGN KEY (company_id, order_line_id) REFERENCES cf_sales_order_lines(company_id, id),
  CONSTRAINT fk_cpsp_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

-- A stretched bar: the first week its work is spread from (NULL = booked back
-- from the ship week, or forward from its material when auto-placed).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plan_entries' AND COLUMN_NAME = 'start_date');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_plan_entries ADD COLUMN start_date DATE NULL AFTER ship_date', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §48  CUT FROM — plate AND section cutting, places by id (CF_ERP_CUT_FROM_PLAN.md)
-- ============================================================================
-- CUT_FROM (option PLATE | SECTION | NONE) says how a definition's / item's
-- pieces are cut; it is inherited down the classification and from a template
-- definition to the items made from it, like SHIP_UNIT. A SECTION part names
-- the stock bar it is cut from in cut_stock_id (a definition's is the default,
-- an item's overrides). Where cut pieces, raw stock and offcuts are filed is a
-- company setting by node id (cf_cut_places), not a classification code.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_master_records' AND COLUMN_NAME = 'cut_stock_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_master_records ADD COLUMN cut_stock_id INT NULL AFTER default_flow_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @ix = (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_master_records' AND INDEX_NAME = 'idx_cmr_cut_stock');
SET @sql = IF(@ix = 0, 'ALTER TABLE cf_master_records ADD KEY idx_cmr_cut_stock (company_id, cut_stock_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_master_records' AND CONSTRAINT_NAME = 'fk_cmr_cut_stock');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_master_records ADD CONSTRAINT fk_cmr_cut_stock FOREIGN KEY (company_id, cut_stock_id) REFERENCES cf_master_records(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS cf_cut_places (
  id              INT        AUTO_INCREMENT PRIMARY KEY,
  company_id      INT        NOT NULL,
  kind            ENUM('plate','section') NOT NULL,
  blanks_node_id  INT        NULL,               -- where cut pieces of this kind are filed
  offcut_node_id  INT        NULL,               -- where offcuts of this kind are filed
  updated_by      INT        NULL,
  created_at      TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ccpl_tenant (company_id, id),
  UNIQUE KEY uq_ccpl_kind   (company_id, kind),
  CONSTRAINT fk_ccpl_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccpl_blanks  FOREIGN KEY (company_id, blanks_node_id) REFERENCES cf_classification_nodes(company_id, id),
  CONSTRAINT fk_ccpl_offcut  FOREIGN KEY (company_id, offcut_node_id) REFERENCES cf_classification_nodes(company_id, id),
  CONSTRAINT fk_ccpl_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- The raw stock of a kind: one or more classification subtrees (plates sit
-- under one node; angles, beams and channels under three).
CREATE TABLE IF NOT EXISTS cf_cut_place_stock (
  id          INT        AUTO_INCREMENT PRIMARY KEY,
  company_id  INT        NOT NULL,
  place_id    INT        NOT NULL,
  node_id     INT        NOT NULL,
  created_at  TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ccps_tenant (company_id, id),
  UNIQUE KEY uq_ccps_node   (company_id, place_id, node_id),
  CONSTRAINT fk_ccps_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ccps_place   FOREIGN KEY (company_id, place_id) REFERENCES cf_cut_places(company_id, id),
  CONSTRAINT fk_ccps_node    FOREIGN KEY (company_id, node_id) REFERENCES cf_classification_nodes(company_id, id)
);

-- Section cutting: saw kerf per cut, trim at each end of a bar, the shortest
-- leftover kept as a reusable offcut. One row per company; none = these defaults.
CREATE TABLE IF NOT EXISTS cf_section_settings (
  company_id      INT            NOT NULL PRIMARY KEY,
  saw_kerf_mm     DECIMAL(8,2)   NOT NULL DEFAULT 3.00,
  end_trim_mm     DECIMAL(8,2)   NOT NULL DEFAULT 10.00,
  min_offcut_mm   DECIMAL(10,2)  NOT NULL DEFAULT 500.00,
  updated_by      INT            NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_csst_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_csst_updater FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- A bar is a lot too: one stock bar, its pieces placed along it (x_mm), its
-- leftover an offcut with a length. The plate tables carry both kinds.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_plate_lots' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col = 0, "ALTER TABLE cf_plate_lots ADD COLUMN kind ENUM('plate','bar') NOT NULL DEFAULT 'plate' AFTER source", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col = 0, "ALTER TABLE cf_offcuts ADD COLUMN kind ENUM('plate','bar') NOT NULL DEFAULT 'plate' AFTER offcut_no", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND COLUMN_NAME = 'length_mm');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_offcuts ADD COLUMN length_mm DECIMAL(12,3) NULL AFTER area_mm2', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_offcuts' AND COLUMN_NAME = 'stock_item_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_offcuts ADD COLUMN stock_item_id INT NULL AFTER length_mm', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- CUT_FROM per cf_erp company, its three options, and a defaulted rule on every
-- Family that holds a template definition (the same Families as SHIP_UNIT).
INSERT INTO cf_specifications (company_id, code, name, data_type, description, status)
SELECT c.id, 'CUT_FROM', 'Cut from', 'option',
       'How pieces of this kind are cut: from a plate (flat, by thickness, length, width and grade), from a section (a stock bar such as an angle, cut to length), or not cut at all. Set it on a classification or a definition; everything below or made from it follows unless it says otherwise.',
       'active'
  FROM companies c
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM apps ap WHERE ap.company_id = c.id AND ap.slug = 'cf_erp' AND ap.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM cf_specifications s WHERE s.company_id = c.id AND s.code = 'CUT_FROM' AND s.deleted_at IS NULL);

INSERT INTO cf_spec_options (company_id, specification_id, value, label, sort_order, status)
SELECT s.company_id, s.id, o.value, o.label, o.sort_order, 'active'
  FROM cf_specifications s
  JOIN (SELECT 'PLATE' AS value, 'Plate' AS label, 1 AS sort_order
        UNION ALL SELECT 'SECTION', 'Section (cut to length)', 2
        UNION ALL SELECT 'NONE', 'Not cut', 3) o
 WHERE s.code = 'CUT_FROM' AND s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM cf_spec_options x
                    WHERE x.company_id = s.company_id AND x.specification_id = s.id AND x.value = o.value AND x.deleted_at IS NULL);

INSERT INTO cf_spec_assignments
  (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule)
SELECT f.company_id, s.id, 'classification', f.id, 'item', 0, 1, 'defaulted'
  FROM cf_classification_nodes f
  JOIN cf_specifications s
    ON s.company_id = f.company_id AND s.code = 'CUT_FROM' AND s.deleted_at IS NULL
 WHERE f.depth = 0 AND f.deleted_at IS NULL AND f.scope <> 'machine'
   AND EXISTS (SELECT 1
                 FROM cf_master_records m
                 JOIN cf_definition_details d ON d.master_id = m.id AND d.definition_type = 'template' AND d.deleted_at IS NULL
                 JOIN cf_classification_nodes n  ON n.id = m.classification_id
                 LEFT JOIN cf_classification_nodes p1 ON p1.id = n.parent_id
                 LEFT JOIN cf_classification_nodes p2 ON p2.id = p1.parent_id
                WHERE m.company_id = f.company_id AND m.deleted_at IS NULL
                  AND f.id = CASE n.depth WHEN 0 THEN n.id WHEN 1 THEN p1.id ELSE p2.id END)
   AND NOT EXISTS (SELECT 1 FROM cf_spec_assignments a
                    WHERE a.company_id = f.company_id AND a.specification_id = s.id
                      AND a.subject_type = 'classification' AND a.subject_id = f.id
                      AND a.deleted_at IS NULL);

-- Places, once, from the codes they were found by until now (afterwards only
-- the ids count; Setup › Cutting changes them).
INSERT INTO cf_cut_places (company_id, kind, blanks_node_id, offcut_node_id)
SELECT c.id, 'plate',
       (SELECT n.id FROM cf_classification_nodes n WHERE n.company_id = c.id AND n.code = 'CUT_PLATE' AND n.deleted_at IS NULL ORDER BY n.id LIMIT 1),
       (SELECT n.id FROM cf_classification_nodes n WHERE n.company_id = c.id AND n.code = 'OFFCUT' AND n.deleted_at IS NULL ORDER BY n.id LIMIT 1)
  FROM companies c
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM apps ap WHERE ap.company_id = c.id AND ap.slug = 'cf_erp' AND ap.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM cf_cut_places p WHERE p.company_id = c.id AND p.kind = 'plate');
INSERT INTO cf_cut_places (company_id, kind)
SELECT c.id, 'section'
  FROM companies c
 WHERE c.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM apps ap WHERE ap.company_id = c.id AND ap.slug = 'cf_erp' AND ap.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM cf_cut_places p WHERE p.company_id = c.id AND p.kind = 'section');
INSERT INTO cf_cut_place_stock (company_id, place_id, node_id)
SELECT p.company_id, p.id, n.id
  FROM cf_cut_places p
  JOIN cf_classification_nodes n ON n.company_id = p.company_id AND n.deleted_at IS NULL
   AND ((p.kind = 'plate' AND n.code = 'PLATE') OR (p.kind = 'section' AND n.code IN ('ANGLES','BEAMS','CHANNELS')))
 WHERE NOT EXISTS (SELECT 1 FROM cf_cut_place_stock x WHERE x.company_id = p.company_id AND x.place_id = p.id);

-- §48b  The flow a new CUT SECTION takes (Backend A, 2026-10-08) — the section
-- twin of cut_plate_flow_id (§33): cut sections are made automatically, with
-- nobody there to choose a flow, so the house says once which flow a new one
-- takes. Unset = release refuses a cut section with no flow, in words.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND COLUMN_NAME = 'cut_section_flow_id');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_company_settings ADD COLUMN cut_section_flow_id INT NULL AFTER cut_plate_flow_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_company_settings' AND CONSTRAINT_NAME = 'fk_cfcs_cut_section_flow');
SET @sql = IF(@fk = 0, 'ALTER TABLE cf_company_settings ADD CONSTRAINT fk_cfcs_cut_section_flow FOREIGN KEY (company_id, cut_section_flow_id) REFERENCES cf_operation_flows(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §49  Operation times live on the operation's rule (2026-10-08)
-- ============================================================================
-- The user: "are all formulas now on the operation itself (which I feel is
-- ideal)". Each machine rule carries its own work / setup expression — a
-- number for a fixed time. Shared cf_formulas stay for VALUE formulas only
-- (weights, areas); scripts/cf_kepl/time-formulas-to-rules.mjs moves the old
-- time formulas onto their rules and retires them. Until then a rule with no
-- expression of its own reads its linked formula as before.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_operation_machine_rules' AND COLUMN_NAME = 'work_expression');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_operation_machine_rules ADD COLUMN work_expression TEXT NULL AFTER work_formula_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_operation_machine_rules' AND COLUMN_NAME = 'setup_expression');
SET @sql = IF(@col = 0, 'ALTER TABLE cf_operation_machine_rules ADD COLUMN setup_expression TEXT NULL AFTER setup_formula_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §50  A record's flow decides which values it needs (2026-10-08)
-- ============================================================================
-- Every item.X an operation's time formula reads becomes a REQUIRED value on
-- the definition / item whose flow holds that operation, unless its chain
-- already gives it (services/flowSpecService.js). Those rules are marked
-- origin 'flow' so they can be taken away again when the flow stops reading
-- them (only when nobody filled them in); a rule made by hand is 'manual'.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_spec_assignments' AND COLUMN_NAME = 'origin');
SET @sql = IF(@col = 0, "ALTER TABLE cf_spec_assignments ADD COLUMN origin ENUM('manual','flow') NOT NULL DEFAULT 'manual' AFTER sort_order", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §51  Part drawings (2026-10-08)
-- ============================================================================
-- A plate part's DXF, uploaded on its order line and matched to the line's
-- rows by DRAWING MARK (the file name). services/partGeometry.js reads it:
-- the rectangle around the outline (what nesting lays out), the true area,
-- the cut length (outline + cut-outs; holes up to 50 mm are drilled) and the
-- piercings. plateCutsService takes cut length and piercings from here, and a
-- shared cut only saves the share of a side the outline really runs along.
-- One live drawing per line and mark; a new upload of the mark replaces it.
CREATE TABLE IF NOT EXISTS cf_part_drawings (
  id              INT NOT NULL AUTO_INCREMENT,
  company_id      INT NOT NULL,
  order_line_id   INT NOT NULL,
  mark            VARCHAR(120) NOT NULL,
  mark_norm       VARCHAR(120) NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  length_mm       DECIMAL(12,3) NOT NULL,
  width_mm        DECIMAL(12,3) NOT NULL,
  area_mm2        DECIMAL(16,3) NOT NULL,
  cut_length_mm   DECIMAL(14,3) NOT NULL,
  piercings       INT NOT NULL DEFAULT 1,
  holes           INT NOT NULL DEFAULT 0,
  inner_cuts      INT NOT NULL DEFAULT 0,
  geometry_json   MEDIUMTEXT NOT NULL,
  warnings_json   TEXT NULL,
  dxf_text        MEDIUMTEXT NULL,
  deleted_at      DATETIME NULL,
  created_at      TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  created_by      INT NULL,
  is_live         TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cpd_tenant (company_id, id),
  UNIQUE KEY uq_cpd_mark (company_id, order_line_id, mark_norm, is_live),
  KEY idx_cpd_line (company_id, order_line_id),
  CONSTRAINT fk_cpd_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_cpd_line FOREIGN KEY (order_line_id) REFERENCES cf_sales_order_lines (id)
);

-- §51b  Drawings on every level (2026-10-08): DXF or PDF, on any row of the line
-- matched by drawing mark. Only a plate part's DXF is read as a shape, so the
-- shape columns are empty for the rest; dxf_text holds the file itself (DXF
-- text, or a PDF as base64 — file_kind says which).
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_part_drawings' AND COLUMN_NAME = 'file_kind');
SET @sql = IF(@col = 0, "ALTER TABLE cf_part_drawings ADD COLUMN file_kind ENUM('dxf','pdf') NOT NULL DEFAULT 'dxf' AFTER file_name", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @nn = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_part_drawings' AND COLUMN_NAME = 'geometry_json' AND IS_NULLABLE = 'NO');
SET @sql = IF(@nn = 1, 'ALTER TABLE cf_part_drawings MODIFY length_mm DECIMAL(12,3) NULL, MODIFY width_mm DECIMAL(12,3) NULL, MODIFY area_mm2 DECIMAL(16,3) NULL, MODIFY cut_length_mm DECIMAL(14,3) NULL, MODIFY piercings INT NULL, MODIFY holes INT NULL, MODIFY inner_cuts INT NULL, MODIFY geometry_json MEDIUMTEXT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §52  A drawing's file is a revision's file (2026-10-09, option B)
-- ============================================================================
-- Every file uploaded on an order line belongs to a revision in the drawings
-- register (cf_drawings, §20): the register says which sheet and revision a
-- row is built to, cf_part_drawings holds that revision's file. A drawing can
-- start from a row before its file exists; uploading again over an ISSUED
-- revision makes the next revision (the old file stays on the old revision, so
-- "what was it built to" can still be downloaded). A file is matched to rows by
-- drawing mark AND by the register's links.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_part_drawings' AND COLUMN_NAME = 'drawing_id');
-- Two statements: TiDB refuses an index on a column added in the same ALTER.
SET @sql = IF(@col = 0, 'ALTER TABLE cf_part_drawings ADD COLUMN drawing_id INT NULL AFTER order_line_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @key = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_part_drawings' AND INDEX_NAME = 'idx_cpd_drawing');
SET @sql = IF(@key = 0, 'ALTER TABLE cf_part_drawings ADD KEY idx_cpd_drawing (company_id, drawing_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================================
-- §53  Wait for every piece below (2026-10-10)
-- ============================================================================
-- relation 'descendants': every node under the waiting one, at any depth,
-- optionally made from one template — a span's trial assembly waits for its
-- girder segments (two levels down) to finish fabrication.
SET @has = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_step_wait_rules' AND COLUMN_NAME = 'relation' AND COLUMN_TYPE LIKE '%descendants%');
SET @sql = IF(@has = 0, "ALTER TABLE cf_step_wait_rules MODIFY relation ENUM('parent','children','siblings','ancestor','descendants') NOT NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
