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
  relation              ENUM('parent','children','siblings','ancestor') NOT NULL,
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
  movement_type   ENUM('receipt','issue','transfer','adjustment','scrap') NOT NULL,
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
  origin          ENUM('flow','rule','default') NOT NULL,
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
