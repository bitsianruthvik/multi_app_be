-- ============================================================================
-- cf_hrms — People + Organisation Definition. Full schema, 46 tables.
-- ============================================================================
-- Built from HRMS_Core_V1_Taxonomy + HRMS_Core_V1_Architecture (the complete
-- logical model) and Org_Chart_V12.html (Karni Packaging, Unit 2 — the first
-- real migration). Every decision behind this file, and the reasoning for each
-- deviation from the spec, is recorded in TM/CF_HRMS_PLAN.md. Read that before
-- changing a table here.
--
-- THE MODEL IN ONE PARAGRAPH
--   The centre of this app is not the employee row and not the org-chart box.
--   It is the WORK ASSIGNMENT: the record of what one person is actually doing
--   right now. An employee has 1..n concurrent assignments, each with its own
--   Role, optional Position, allocation %, work contexts, default shift and its
--   own set of managers. A ROLE is the reusable definition of a kind of work
--   and carries reusable content (KRAs, responsibilities, KPIs, skills,
--   qualifications, experience, authorities, relationship expectations, working
--   conditions). A POSITION is an optional sanctioned slot that a Role fills in
--   a department and location. Positions and Work Assignments may ADD to,
--   OVERRIDE or SUPPRESS the role's content — they never copy it. Two documents
--   are generated from the resolved content (a Role JD and an Employee
--   Responsibility Profile) and each generation freezes its source into a
--   snapshot, so an old document never silently re-renders against today's role
--   definition. Attendance and leave sit at EMPLOYEE level, never per role.
--
-- THE NON-NEGOTIABLES (plan §2), restated as what this file guarantees
--   1. `employee.manager_id` does not exist. Reporting is
--      hrms_assignment_reporting_relationships (actual) over
--      hrms_position_reporting_relationships (formal). Neither is a column.
--   2. `employee.position_id` does not exist. The employee-to-work link is
--      hrms_work_assignments, and only that.
--   3. Machines and areas are never managers. They are hrms_work_contexts, and
--      no reporting table can point at one — the FKs make that impossible.
--   4. KRA != Responsibility != KPI. Three definition tables, three role
--      assignment tables, never one text list.
--   5. Position is OPTIONAL on a work assignment (position_id NULL); Role is
--      REQUIRED (role_id NOT NULL).
--   6. Resolution order is Role content -> Position overlay -> Assignment
--      overlay, each applying SUPPRESS, then OVERRIDE, then ADD. One
--      implementation: services/contentResolver.js. Nothing else re-implements it.
--   7. A generated document saves its full render snapshot
--      (hrms_generated_documents.snapshot_json is NOT NULL).
--   8. Effective-dated rows are ENDED, not overwritten. Every such table carries
--      effective_from / effective_to and is indexed for "what is active today".
--
-- PLATFORM RULES EVERY TABLE FOLLOWS
--   * company_id on every table. Tenant scoping on the generic read path is
--     derived from the table's REAL columns now (the engine inspects them), not
--     from whether resourceDef.json happens to expose a `companyId` field — so
--     a forgotten mapping is no longer a cross-tenant leak. Map `companyId`
--     anyway: every screen filters and displays on it, and the mapping is what
--     makes that possible.
--     Generic WRITES are opt-in: a resource is writable through
--     /api/query/v1/base_resource only if its resourceDef says
--     `"writable": true`. None of cf_hrms's 46 do, deliberately — every write in
--     this app goes through its own routes, where the rules TiDB cannot enforce
--     actually live. Adding that key to a resource hands out a write path that
--     skips all of them. See multi_app_be/architecture/data-access.md.
--   * The spec's `organizations` table and `organization_id` FK are DROPPED in
--     favour of the platform's `companies` / `company_id`. The platform already
--     is the tenant boundary; a second one would need its own isolation code and
--     would not be enforced by securityInjector.
--   * deleted_at on every table — the query engine always appends
--     `deleted_at IS NULL` to the main table of a read.
--   * Soft-delete-aware uniqueness uses VIRTUAL generated columns that go NULL
--     when a row is deleted (`code_active`, `name_active`, `*_date_active`).
--     MySQL never compares NULLs in a unique index, so a deleted row never
--     blocks reuse of its code, and the platform's generic delete (which only
--     sets deleted_at) needs no help. Same pattern fab_erp and cf_erp run in
--     production today.
--   * Every reference between hrms_ tables is a COMPOSITE foreign key on
--     (company_id, <ref>_id) -> (company_id, id). The database refuses a row in
--     company A that points at a row in company B. That matters because relation
--     joins in the generic query API do NOT re-check company: one cross-tenant
--     reference would surface another tenant's employee names in a read. Every
--     table therefore carries UNIQUE (company_id, id) — on all of them, not only
--     the ones referenced today, so a reference added in a later phase is a new
--     FK and not an ALTER on a live table.
--   * References to the PLATFORM tables `users` and `companies` are plain FKs on
--     id, because those tables have no (company_id, id) unique key. Where a
--     users reference must belong to the same tenant (hrms_employees.user_id),
--     the service checks it — noted at that column.
--   * created_at / updated_at / created_by on every table.
--
-- PRODUCTION IS TiDB v8.5.3
--   * Foreign keys ARE enforced (foreign_key_checks = 1), so the FKs below are
--     real guarantees in prod, not documentation.
--   * CHECK constraints are NOT (tidb_enable_check_constraint = 0). There is
--     therefore no CHECK anywhere in this file. Every rule that would have been
--     one is named, at its table, with the service that enforces it instead.
--   * There are NO triggers. hrms_audit_log rows are written by the service that
--     makes the change — never assume a write outside that service is audited.
--
-- FILE ORDER IS LOAD-BEARING. Inline FKs mean a referenced table must already
-- exist. The order is: organisation -> content masters -> roles and role
-- content -> positions -> people -> work assignments -> workforce -> leave ->
-- documents and governance. Two consequences worth naming:
--   * hrms_shifts is created in section 1, not with the workforce tables, because
--     hrms_positions.default_shift_id and hrms_work_assignments.default_shift_id
--     both need it.
--   * hrms_employment_events.work_assignment_id points FORWARD, at a table
--     created two sections later. That one FK is added by a guarded ALTER in
--     section 6e, once both tables exist.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS only, and every ALTER is guarded by an
-- information_schema check. No DROPs in this file, ever. Safe to run twice.
-- ============================================================================


-- ############################################################################
-- ## 1. ORGANISATION — the fixed points everything else hangs off            ##
-- ############################################################################
-- Nothing in this section depends on roles, people or work. It is created first
-- so the rest of the file can reference it freely.


-- ----- 1a. Locations --------------------------------------------------------
-- A plant, unit, office, branch or site. Self-parenting, because a SME's real
-- geography is "Unit 2 is inside Karni Packaging, Bhilwara" and a holiday
-- calendar or a position filter needs to walk that.
--
-- `code` is optional (the spec marks it UQ but nullable): a company may run for
-- months with named-only locations. When present it is unique per company, and
-- unique case-insensitively, because codes appear in imports and exports where
-- "u2" and "U2" must mean the same place.

CREATE TABLE IF NOT EXISTS hrms_locations (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  code               VARCHAR(50)  NULL,
  name               VARCHAR(200) NOT NULL,
  location_type      ENUM('PLANT','OFFICE','UNIT','BRANCH','SITE','OTHER') NOT NULL DEFAULT 'PLANT',
  parent_location_id INT          NULL,
  address_json       JSON         NULL,
  status             ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  code_active        VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hloc_tenant (company_id, id),
  UNIQUE KEY uq_hloc_code   (company_id, code_active),
  KEY idx_hloc_parent (company_id, parent_location_id),
  KEY idx_hloc_status (company_id, status),

  CONSTRAINT fk_hloc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hloc_parent  FOREIGN KEY (company_id, parent_location_id) REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hloc_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1b. Departments ------------------------------------------------------
-- Functional units — Production, Quality, Accounts, HR — hierarchical, because
-- "Printing" sits under "Production" and a JD names the deeper one.
--
-- SERVICE RULE (no CHECK in TiDB): a department may not be its own ancestor.
-- organisationService.js walks parent_department_id on save and rejects a cycle.

CREATE TABLE IF NOT EXISTS hrms_departments (
  id                   INT          AUTO_INCREMENT PRIMARY KEY,
  company_id           INT          NOT NULL,
  code                 VARCHAR(50)  NULL,
  name                 VARCHAR(200) NOT NULL,
  parent_department_id INT          NULL,
  status               ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at           DATETIME     DEFAULT NULL,
  created_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT          NULL,

  code_active          VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hdep_tenant (company_id, id),
  UNIQUE KEY uq_hdep_code   (company_id, code_active),
  KEY idx_hdep_parent (company_id, parent_department_id),
  KEY idx_hdep_status (company_id, status),

  CONSTRAINT fk_hdep_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hdep_parent  FOREIGN KEY (company_id, parent_department_id) REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hdep_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1c. Work contexts — THE REASON MACHINES ARE NOT MANAGERS -------------
-- (Non-negotiable 3.) The source org chart draws the Pelican machine as a box
-- with people under it, and every naive import turns that box into a manager.
-- It is not one. A machine, line, area, project or cell is an operational
-- CONTEXT that a Position or a Work Assignment covers, linked through
-- hrms_position_work_contexts / hrms_work_assignment_contexts.
--
-- Nothing in this schema can make a context a manager: the two reporting tables
-- have FKs to hrms_positions and hrms_employees, and neither can hold a context
-- id. That is deliberate — it is the one rule that must survive a careless
-- importer, so it is enforced by the database rather than by review.
--
-- `external_ref` is the ERP's or the PLC's own identifier for the machine, so a
-- later integration can join without matching on name.
-- Contexts self-parent: an AREA contains LINEs, a LINE contains MACHINEs.

CREATE TABLE IF NOT EXISTS hrms_work_contexts (
  id                INT          AUTO_INCREMENT PRIMARY KEY,
  company_id        INT          NOT NULL,
  code              VARCHAR(50)  NULL,
  name              VARCHAR(200) NOT NULL,          -- e.g. 'Pelican Machine'
  context_type      ENUM('MACHINE','LINE','AREA','PROJECT','CELL','OTHER') NOT NULL DEFAULT 'MACHINE',
  location_id       INT          NULL,
  department_id     INT          NULL,
  parent_context_id INT          NULL,
  external_ref      VARCHAR(100) NULL,              -- ERP / machine reference
  status            ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  metadata_json     JSON         NULL,              -- type-specific data

  deleted_at        DATETIME     DEFAULT NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT          NULL,

  code_active       VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  name_active       VARCHAR(200) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hwct_tenant (company_id, id),
  UNIQUE KEY uq_hwct_code   (company_id, code_active),
  -- One 'Pelican Machine' per company. The org-chart import relies on this to
  -- collapse the same machine appearing under two nodes into one context.
  UNIQUE KEY uq_hwct_name   (company_id, name_active),
  KEY idx_hwct_type     (company_id, context_type, status),
  KEY idx_hwct_location (company_id, location_id),
  KEY idx_hwct_dept     (company_id, department_id),
  KEY idx_hwct_parent   (company_id, parent_context_id),

  CONSTRAINT fk_hwct_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hwct_location FOREIGN KEY (company_id, location_id)       REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hwct_dept     FOREIGN KEY (company_id, department_id)     REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hwct_parent   FOREIGN KEY (company_id, parent_context_id) REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_hwct_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1d. Contractors ------------------------------------------------------
-- The external employer of contract labour. An employee whose employment_type
-- is CONTRACT carries contractor_id; the person is still ONE employee row in
-- this system, because attendance, leave and assignments are about the person.

CREATE TABLE IF NOT EXISTS hrms_contractors (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  code         VARCHAR(50)  NULL,
  name         VARCHAR(200) NOT NULL,
  contact_json JSON         NULL,
  status       ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  code_active  VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  name_active  VARCHAR(200) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hcon_tenant (company_id, id),
  UNIQUE KEY uq_hcon_code   (company_id, code_active),
  UNIQUE KEY uq_hcon_name   (company_id, name_active),
  KEY idx_hcon_status (company_id, status),

  CONSTRAINT fk_hcon_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcon_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1e. Shifts — CREATED EARLY ON PURPOSE --------------------------------
-- Positions (1.4) and Work Assignments (1.6) both carry default_shift_id, and
-- the spec calls those "deferred FK" because it assumed a migration per table.
-- This file is one idempotent script, so the dependency is resolved by ORDER:
-- shifts exist before anything that points at them. Moving this table down the
-- file breaks the build.
--
-- start_time / end_time are NULLABLE, and that is not laziness. A General shift
-- in an SME has no fixed hours — staff are expected during the working day, and
-- writing 09:00-18:00 would make every late arrival a fabricated exception. The
-- seed ships G with NULL times for exactly this reason.
--
-- crosses_midnight is stored rather than derived from end_time < start_time,
-- because a shift with NULL times can still be a night shift by policy, and
-- because the attendance service must not re-derive a wall-clock rule per read.

CREATE TABLE IF NOT EXISTS hrms_shifts (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  code               VARCHAR(50)  NOT NULL,          -- G / D / N
  name               VARCHAR(100) NOT NULL,
  start_time         TIME         NULL,              -- NULL = flexible / general
  end_time           TIME         NULL,
  crosses_midnight   TINYINT(1)   NOT NULL DEFAULT 0,
  grace_in_minutes   INT          NOT NULL DEFAULT 0,
  grace_out_minutes  INT          NOT NULL DEFAULT 0,
  status             ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  code_active        VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hshf_tenant (company_id, id),
  UNIQUE KEY uq_hshf_code   (company_id, code_active),
  KEY idx_hshf_status (company_id, status),

  CONSTRAINT fk_hshf_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hshf_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1f. Holidays ---------------------------------------------------------
-- The calendar attendance reads to decide whether an absent day is an absence.
-- location_id NULL means company-wide; a row with a location overrides nothing —
-- both apply, and the attendance service treats a date as a holiday if ANY
-- applicable row matches.
--
-- `location_key` exists only so the unique index can treat "company-wide" as a
-- single value: MySQL does not compare NULLs in a unique index, so without it
-- a company-wide holiday could be inserted twice.

CREATE TABLE IF NOT EXISTS hrms_holidays (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  location_id  INT          NULL,                   -- NULL = whole company
  holiday_date DATE         NOT NULL,
  name         VARCHAR(200) NOT NULL,
  is_optional  TINYINT(1)   NOT NULL DEFAULT 0,

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  location_key INT          GENERATED ALWAYS AS (IFNULL(location_id, 0)) VIRTUAL,
  date_active  DATE         GENERATED ALWAYS AS (IF(deleted_at IS NULL, holiday_date, NULL)) VIRTUAL,

  UNIQUE KEY uq_hhol_tenant (company_id, id),
  UNIQUE KEY uq_hhol_day    (company_id, location_key, date_active),
  KEY idx_hhol_date (company_id, holiday_date),

  CONSTRAINT fk_hhol_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hhol_location FOREIGN KEY (company_id, location_id) REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hhol_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1g. Reporting relationship types -------------------------------------
-- Reporting is typed and configurable, not a single manager column
-- (non-negotiable 1). The same assignment can have a PRIMARY manager and a
-- FUNCTIONAL one at once; the chart draws only the formal ones.
--
--   is_formal      — does this type draw a solid line in the org chart, and
--                    does the cycle check apply to it? PRIMARY yes, DOTTED no.
--   allow_multiple — may one source have several active relationships of this
--                    type? PRIMARY no (one primary manager), PROJECT yes.
-- Both are enforced by positionService.js / assignmentService.js, not by the
-- database: "one active PRIMARY per source" depends on effective dates, which
-- a unique index cannot express.
--
-- Seeded with PRIMARY, FUNCTIONAL, ADMIN, DOTTED, PROJECT, SHIFT (seed.sql).

CREATE TABLE IF NOT EXISTS hrms_reporting_relationship_types (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  company_id     INT          NOT NULL,
  code           VARCHAR(50)  NOT NULL,
  name           VARCHAR(100) NOT NULL,
  is_formal      TINYINT(1)   NOT NULL DEFAULT 1,
  allow_multiple TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order     INT          NOT NULL DEFAULT 0,
  status         ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at     DATETIME     DEFAULT NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT          NULL,

  code_active    VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hrrt_tenant (company_id, id),
  UNIQUE KEY uq_hrrt_code   (company_id, code_active),
  KEY idx_hrrt_status (company_id, status, sort_order),

  CONSTRAINT fk_hrrt_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrrt_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 2. CONTENT MASTERS — define once, assign to a context                   ##
-- ############################################################################
-- (Non-negotiable 4.) KRA, Responsibility and KPI are three different things
-- and get three tables. A KRA is an OUTCOME AREA the role is accountable for
-- ("Production Efficiency"). A RESPONSIBILITY is an activity or duty expected
-- from it ("Review machine-wise output"). A KPI is the MEASURE that judges the
-- outcome ("Plan achievement %"). Collapsing them into one text list is the
-- single most common way an HRMS stops being able to generate a real JD, and
-- the reason the spec names it first.
--
-- All six masters are reusable: the definition says what the thing IS; the
-- role assignment tables in section 3 say what it means FOR THIS ROLE (target,
-- weight, order, dates). The same KPI can be GTE 95% for one role and INFO-only
-- for another without duplicating the definition.
--
-- UNIQUENESS, and why it is not uniform across the six:
--   KRA / KPI / skill / qualification / authority names ARE unique per company.
--   These are small, curated vocabularies; a second "Production Efficiency"
--   defeats the whole point of reuse, and the org-chart import's "normalise
--   duplicates" rule needs a database backstop.
--   RESPONSIBILITY names are NOT unique. They are the long tail: the Karni
--   import turns ~105 roles' `kras[]` task statements into responsibilities,
--   and two genuinely different duties can share a short label while differing
--   in the full statement. A hard unique there would make an import fail on a
--   trailing full stop. importService.js dedupes on normalised text instead and
--   reports what it merged.


-- ----- 2a. KRA definitions --------------------------------------------------
-- Outcome areas. Deliberately few per company — if a company has 200 KRAs they
-- are writing responsibilities in the wrong table.

CREATE TABLE IF NOT EXISTS hrms_kra_definitions (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  company_id  INT          NOT NULL,
  code        VARCHAR(50)  NULL,
  name        VARCHAR(200) NOT NULL,
  description TEXT         NULL,                   -- meaning / scope
  category    VARCHAR(100) NULL,                   -- optional taxonomy
  status      ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at  DATETIME     DEFAULT NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by  INT          NULL,

  code_active VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  name_active VARCHAR(200) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hkrd_tenant (company_id, id),
  UNIQUE KEY uq_hkrd_code   (company_id, code_active),
  UNIQUE KEY uq_hkrd_name   (company_id, name_active),
  KEY idx_hkrd_status (company_id, status),

  CONSTRAINT fk_hkrd_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hkrd_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 2b. Responsibility definitions ---------------------------------------
-- Duties and accountabilities. `name` is the short label the JD lists;
-- `description` is the full statement and is REQUIRED, because a responsibility
-- that cannot be written out in a sentence is not one.
--
-- responsibility_class is the DEFAULT stance for this duty; a role assignment
-- may override it (hrms_role_responsibility_assignments.responsibility_class_override)
-- because the same duty is OWNER for the operator and REVIEWER for the incharge.

CREATE TABLE IF NOT EXISTS hrms_responsibility_definitions (
  id                   INT          AUTO_INCREMENT PRIMARY KEY,
  company_id           INT          NOT NULL,
  code                 VARCHAR(50)  NULL,
  name                 VARCHAR(250) NOT NULL,      -- short label
  description          TEXT         NOT NULL,      -- full responsibility statement
  responsibility_class ENUM('OWNER','JOINT_OWNER','SUPPORT','BACKUP','APPROVER','REVIEWER','GENERIC') NULL,
  status               ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at           DATETIME     DEFAULT NULL,
  created_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT          NULL,

  code_active          VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hrsd_tenant (company_id, id),
  UNIQUE KEY uq_hrsd_code   (company_id, code_active),
  -- Deliberately NO unique on name — see the section comment.
  KEY idx_hrsd_status (company_id, status),
  KEY idx_hrsd_name   (company_id, name(100)),

  CONSTRAINT fk_hrsd_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrsd_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 2c. KPI definitions --------------------------------------------------
-- HOW a thing is measured, independent of any role's expectation of it. The
-- target does NOT live here — it lives on hrms_role_kpi_assignments, because the
-- same "Plan achievement %" is 95% for a supervisor and 85% for a trainee.
--
-- direction is what lets a screen colour a number without being told twice:
-- HIGHER_BETTER for output, LOWER_BETTER for downtime, TARGET_RANGE for a
-- tolerance band, NEUTRAL for informational counts.

CREATE TABLE IF NOT EXISTS hrms_kpi_definitions (
  id                INT          AUTO_INCREMENT PRIMARY KEY,
  company_id        INT          NOT NULL,
  code              VARCHAR(50)  NULL,
  name              VARCHAR(250) NOT NULL,
  description       TEXT         NULL,
  measurement_type  ENUM('NUMBER','PERCENTAGE','CURRENCY','DURATION','BOOLEAN','RATING','TEXT') NOT NULL DEFAULT 'NUMBER',
  unit              VARCHAR(50)  NULL,             -- %, minutes, kg
  direction         ENUM('HIGHER_BETTER','LOWER_BETTER','TARGET_RANGE','NEUTRAL') NULL,
  formula_text      TEXT         NULL,             -- human-readable, not evaluated
  data_source       VARCHAR(250) NULL,             -- ERP / manual / attendance
  default_frequency ENUM('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY','ON_EVENT') NULL,
  status            ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at        DATETIME     DEFAULT NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT          NULL,

  code_active       VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  name_active       VARCHAR(250) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hkpd_tenant (company_id, id),
  UNIQUE KEY uq_hkpd_code   (company_id, code_active),
  UNIQUE KEY uq_hkpd_name   (company_id, name_active),
  KEY idx_hkpd_status (company_id, status),

  CONSTRAINT fk_hkpd_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hkpd_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 2d. Skill definitions ------------------------------------------------
-- The spec gives this master no code column; it is a short vocabulary picked
-- from a list, so the name is the identity. Unique per company for that reason.

CREATE TABLE IF NOT EXISTS hrms_skill_definitions (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  company_id  INT          NOT NULL,
  name        VARCHAR(200) NOT NULL,
  skill_type  ENUM('TECHNICAL','BEHAVIOURAL','SYSTEM','MACHINE','OTHER') NOT NULL DEFAULT 'TECHNICAL',
  description TEXT         NULL,
  status      ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at  DATETIME     DEFAULT NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by  INT          NULL,

  name_active VARCHAR(200) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hskd_tenant (company_id, id),
  UNIQUE KEY uq_hskd_name   (company_id, name_active),
  KEY idx_hskd_type (company_id, skill_type, status),

  CONSTRAINT fk_hskd_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hskd_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 2e. Qualification definitions ----------------------------------------
-- Education, certifications and licences. The org-chart import's `quals[]` land
-- here and the unique name is what makes "B.Tech" and "b.tech " one row.

CREATE TABLE IF NOT EXISTS hrms_qualification_definitions (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  name               VARCHAR(250) NOT NULL,
  qualification_type ENUM('EDUCATION','CERTIFICATION','LICENCE','OTHER') NOT NULL DEFAULT 'EDUCATION',
  description        TEXT         NULL,
  status             ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  name_active        VARCHAR(250) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hqld_tenant (company_id, id),
  UNIQUE KEY uq_hqld_name   (company_id, name_active),
  KEY idx_hqld_type (company_id, qualification_type, status),

  CONSTRAINT fk_hqld_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hqld_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 2f. Authority definitions --------------------------------------------
-- What a role may decide, approve, stop, issue or escalate. The LIMIT (amount,
-- scope, condition) is not here — it is on hrms_role_authority_assignments,
-- because "approve purchases" is 50k for one role and 5L for another.

CREATE TABLE IF NOT EXISTS hrms_authority_definitions (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  company_id     INT          NOT NULL,
  name           VARCHAR(250) NOT NULL,
  authority_type ENUM('APPROVE','DECIDE','STOP','ISSUE','ESCALATE','FINANCIAL','OTHER') NOT NULL DEFAULT 'APPROVE',
  description    TEXT         NOT NULL,
  status         ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at     DATETIME     DEFAULT NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT          NULL,

  name_active    VARCHAR(250) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hatd_tenant (company_id, id),
  UNIQUE KEY uq_hatd_name   (company_id, name_active),
  KEY idx_hatd_type (company_id, authority_type, status),

  CONSTRAINT fk_hatd_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hatd_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 3. ROLES AND ROLE CONTENT — the reusable definition of a kind of work   ##
-- ############################################################################
-- A Role answers "what kind of work is this?" (Printing Operator). It is not a
-- person and not a slot. Everything a JD needs sits in the ten tables below,
-- structured rather than free text, because JD generation must be deterministic
-- from data (taxonomy §2) — AI may improve the wording later, but must never be
-- required to know what the role is responsible for.
--
-- Every assignment table here is EFFECTIVE-DATED and every one of them is ENDED
-- rather than overwritten (non-negotiable 8). That is what lets a JD generated
-- in March render from March's content in November. effective_from / effective_to
-- are NULL-open at both ends: NULL from = "always has", NULL to = "still does".
-- The resolver's date predicate is therefore:
--   (effective_from IS NULL OR effective_from <= :on)
--   AND (effective_to IS NULL OR effective_to >= :on)
-- and each table is indexed on (company_id, role_id, effective_from, effective_to)
-- for it.
--
-- ORDER WITHIN THIS SECTION MATTERS: hrms_role_kra_assignments must exist before
-- the responsibility and KPI assignment tables, because both may be GROUPED
-- under a role KRA (role_kra_assignment_id).


-- ----- 3a. Roles ------------------------------------------------------------
-- `role_purpose` is why the role exists, in one paragraph — the taxonomy calls
-- it out separately from role_summary because a JD opens with the purpose and a
-- listing shows the summary.
--
-- `default_department_id` is a DEFAULT, not the truth: the actual department of
-- a job comes from the Position or the Work Assignment. A role can be performed
-- in two departments without being two roles.
--
-- status DRAFT/ACTIVE/RETIRED, and RETIRED rather than deleted: a retired role
-- is still referenced by historical assignments and generated documents
-- (spec §8 — "do not hard-delete referenced Employees, Roles, Positions or Work
-- Assignments; end/retire them"). roleService.js refuses to soft-delete a role
-- that has any assignment, and retires it instead.

CREATE TABLE IF NOT EXISTS hrms_roles (
  id                    INT          AUTO_INCREMENT PRIMARY KEY,
  company_id            INT          NOT NULL,
  role_code             VARCHAR(50)  NULL,
  title                 VARCHAR(200) NOT NULL,     -- canonical title
  role_purpose          TEXT         NULL,         -- why the role exists
  role_summary          TEXT         NULL,
  default_department_id INT          NULL,
  status                ENUM('DRAFT','ACTIVE','RETIRED') NOT NULL DEFAULT 'DRAFT',
  effective_from        DATE         NULL,
  effective_to          DATE         NULL,

  deleted_at            DATETIME     DEFAULT NULL,
  created_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by            INT          NULL,

  code_active           VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(role_code), NULL)) VIRTUAL,
  title_active          VARCHAR(200) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(title), NULL)) VIRTUAL,

  UNIQUE KEY uq_hrol_tenant (company_id, id),
  UNIQUE KEY uq_hrol_code   (company_id, code_active),
  -- One canonical title per company. This is what the org-chart import's "reuse
  -- a Role when titles match after normalisation" rule leans on: 105 chart nodes
  -- collapse into far fewer roles, and the database refuses a silent duplicate.
  UNIQUE KEY uq_hrol_title  (company_id, title_active),
  KEY idx_hrol_status (company_id, status),
  KEY idx_hrol_dept   (company_id, default_department_id),
  KEY idx_hrol_eff    (company_id, effective_from, effective_to),

  CONSTRAINT fk_hrol_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrol_dept    FOREIGN KEY (company_id, default_department_id) REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hrol_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3b. Role KRA assignments ---------------------------------------------
-- Which outcome areas this role is accountable for, in what order, at what
-- weight. `weight_percent` is advisory in V1 — nothing forces the weights of a
-- role's KRAs to total 100, because a half-defined role is better than a role
-- nobody can save. roleContentService.js reports the total so a user can see it.
--
-- This table is the GROUPING SPINE of a JD: responsibilities and KPIs point at
-- a row here, and the document renders "KRA -> its responsibilities -> its KPIs".
-- Items that point at no KRA are still rendered, under "Additional" — dropping
-- them is how a JD silently loses content (spec §5).

CREATE TABLE IF NOT EXISTS hrms_role_kra_assignments (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  role_id           INT           NOT NULL,
  kra_definition_id INT           NOT NULL,
  weight_percent    DECIMAL(5,2)  NULL,
  is_mandatory      TINYINT(1)    NOT NULL DEFAULT 1,
  sequence          INT           NOT NULL DEFAULT 0,   -- JD order
  effective_from    DATE          NULL,
  effective_to      DATE          NULL,
  notes             TEXT          NULL,

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  kra_active        INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, kra_definition_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrka_tenant (company_id, id),
  -- A role carries a given KRA once. A change of weight or dates edits the row
  -- or ends it and adds the next one; it never becomes a second live pairing.
  UNIQUE KEY uq_hrka_pair   (company_id, role_id, kra_active),
  KEY idx_hrka_role (company_id, role_id, sequence),
  KEY idx_hrka_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrka_kra  (company_id, kra_definition_id),

  CONSTRAINT fk_hrka_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrka_role    FOREIGN KEY (company_id, role_id)           REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrka_kra     FOREIGN KEY (company_id, kra_definition_id) REFERENCES hrms_kra_definitions(company_id, id),
  CONSTRAINT fk_hrka_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3c. Role responsibility assignments ----------------------------------
-- The duties this role performs, optionally grouped under one of its KRAs.
--
-- `responsibility_class_override` is the same duty seen from a different seat:
-- "machine cleanliness" is OWNER for the operator and REVIEWER for the incharge,
-- and that is ONE definition with two assignments, not two definitions.
--
-- SERVICE RULE: role_kra_assignment_id, when set, must belong to the SAME role.
-- The composite FK guarantees the same company but not the same role — a CHECK
-- could not express it either. roleContentService.js validates it on write.

CREATE TABLE IF NOT EXISTS hrms_role_responsibility_assignments (
  id                            INT        AUTO_INCREMENT PRIMARY KEY,
  company_id                    INT        NOT NULL,
  role_id                       INT        NOT NULL,
  responsibility_definition_id  INT        NOT NULL,
  role_kra_assignment_id        INT        NULL,   -- grouping; same role
  responsibility_class_override ENUM('OWNER','JOINT_OWNER','SUPPORT','BACKUP','APPROVER','REVIEWER','GENERIC') NULL,
  is_mandatory                  TINYINT(1) NOT NULL DEFAULT 1,
  sequence                      INT        NOT NULL DEFAULT 0,
  effective_from                DATE       NULL,
  effective_to                  DATE       NULL,
  notes                         TEXT       NULL,

  deleted_at                    DATETIME   DEFAULT NULL,
  created_at                    TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by                    INT        NULL,

  resp_active                   INT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, responsibility_definition_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrra_tenant (company_id, id),
  UNIQUE KEY uq_hrra_pair   (company_id, role_id, resp_active),
  KEY idx_hrra_role (company_id, role_id, sequence),
  KEY idx_hrra_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrra_kra  (company_id, role_kra_assignment_id),
  KEY idx_hrra_def  (company_id, responsibility_definition_id),

  CONSTRAINT fk_hrra_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrra_role    FOREIGN KEY (company_id, role_id)                      REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrra_def     FOREIGN KEY (company_id, responsibility_definition_id) REFERENCES hrms_responsibility_definitions(company_id, id),
  CONSTRAINT fk_hrra_kra     FOREIGN KEY (company_id, role_kra_assignment_id)       REFERENCES hrms_role_kra_assignments(company_id, id),
  CONSTRAINT fk_hrra_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3d. Role KPI assignments ---------------------------------------------
-- The target lives HERE and not on the KPI definition, because the same
-- indicator carries different expectations by role (spec, table inventory).
--
-- `target_value` IS JSON, not decimal and not text. The spec says
-- "decimal/text/json — support scalar/range", which is three shapes in one
-- column; JSON is the only one of the three that can hold all of them without
-- a parser per read:
--     GTE     -> {"value": 95}
--     BETWEEN -> {"min": 90, "max": 110}
--     EQ      -> {"value": true}   (a BOOLEAN measurement_type)
--     INFO    -> null              (informational KPI, no target)
--     TEXT    -> {"value": "Zero customer complaints"}
-- A DECIMAL column would have forced a second column for the range's upper bound
-- and a third for text targets; a TEXT column would have made every read guess.
-- The shape is validated against target_operator + the definition's
-- measurement_type by roleContentService.js — TiDB runs no CHECKs, so this is a
-- service rule, and that service is the one place that knows both sides.

CREATE TABLE IF NOT EXISTS hrms_role_kpi_assignments (
  id                     INT           AUTO_INCREMENT PRIMARY KEY,
  company_id             INT           NOT NULL,
  role_id                INT           NOT NULL,
  kpi_definition_id      INT           NOT NULL,
  role_kra_assignment_id INT           NULL,   -- grouping; same role
  target_operator        ENUM('GTE','LTE','EQ','BETWEEN','INFO') NULL,
  target_value           JSON          NULL,   -- scalar or range; see above
  weight_percent         DECIMAL(5,2)  NULL,
  frequency_override     ENUM('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY','ON_EVENT') NULL,
  is_mandatory           TINYINT(1)    NOT NULL DEFAULT 1,
  sequence               INT           NOT NULL DEFAULT 0,
  effective_from         DATE          NULL,
  effective_to           DATE          NULL,
  notes                  TEXT          NULL,

  deleted_at             DATETIME      DEFAULT NULL,
  created_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by             INT           NULL,

  kpi_active             INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, kpi_definition_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrkp_tenant (company_id, id),
  UNIQUE KEY uq_hrkp_pair   (company_id, role_id, kpi_active),
  KEY idx_hrkp_role (company_id, role_id, sequence),
  KEY idx_hrkp_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrkp_kra  (company_id, role_kra_assignment_id),
  KEY idx_hrkp_def  (company_id, kpi_definition_id),

  CONSTRAINT fk_hrkp_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrkp_role    FOREIGN KEY (company_id, role_id)                REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrkp_def     FOREIGN KEY (company_id, kpi_definition_id)      REFERENCES hrms_kpi_definitions(company_id, id),
  CONSTRAINT fk_hrkp_kra     FOREIGN KEY (company_id, role_kra_assignment_id) REFERENCES hrms_role_kra_assignments(company_id, id),
  CONSTRAINT fk_hrkp_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3e. Role skill requirements ------------------------------------------
-- REQUIRED vs PREFERRED is the whole point: a JD that lists everything as
-- required is unusable for hiring. `proficiency_level` is a free string because
-- companies word their scales differently (Basic/Intermediate/Expert, L1/L2/L3)
-- and forcing one enum would make the first company rename their own scale.

CREATE TABLE IF NOT EXISTS hrms_role_skill_requirements (
  id                  INT         AUTO_INCREMENT PRIMARY KEY,
  company_id          INT         NOT NULL,
  role_id             INT         NOT NULL,
  skill_definition_id INT         NOT NULL,
  requirement_level   ENUM('REQUIRED','PREFERRED') NOT NULL DEFAULT 'REQUIRED',
  proficiency_level   VARCHAR(50) NULL,
  sequence            INT         NOT NULL DEFAULT 0,
  notes               TEXT        NULL,
  effective_from      DATE        NULL,
  effective_to        DATE        NULL,

  deleted_at          DATETIME    DEFAULT NULL,
  created_at          TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT         NULL,

  skill_active        INT         GENERATED ALWAYS AS (IF(deleted_at IS NULL, skill_definition_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrsk_tenant (company_id, id),
  UNIQUE KEY uq_hrsk_pair   (company_id, role_id, skill_active),
  KEY idx_hrsk_role (company_id, role_id, sequence),
  KEY idx_hrsk_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrsk_def  (company_id, skill_definition_id),

  CONSTRAINT fk_hrsk_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrsk_role    FOREIGN KEY (company_id, role_id)             REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrsk_def     FOREIGN KEY (company_id, skill_definition_id) REFERENCES hrms_skill_definitions(company_id, id),
  CONSTRAINT fk_hrsk_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3f. Role qualification requirements ----------------------------------

CREATE TABLE IF NOT EXISTS hrms_role_qualification_requirements (
  id                          INT       AUTO_INCREMENT PRIMARY KEY,
  company_id                  INT       NOT NULL,
  role_id                     INT       NOT NULL,
  qualification_definition_id INT       NOT NULL,
  requirement_level           ENUM('REQUIRED','PREFERRED') NOT NULL DEFAULT 'REQUIRED',
  sequence                    INT       NOT NULL DEFAULT 0,
  notes                       TEXT      NULL,
  effective_from              DATE      NULL,
  effective_to                DATE      NULL,

  deleted_at                  DATETIME  DEFAULT NULL,
  created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by                  INT       NULL,

  qual_active                 INT       GENERATED ALWAYS AS (IF(deleted_at IS NULL, qualification_definition_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrqr_tenant (company_id, id),
  UNIQUE KEY uq_hrqr_pair   (company_id, role_id, qual_active),
  KEY idx_hrqr_role (company_id, role_id, sequence),
  KEY idx_hrqr_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrqr_def  (company_id, qualification_definition_id),

  CONSTRAINT fk_hrqr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrqr_role    FOREIGN KEY (company_id, role_id)                     REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrqr_def     FOREIGN KEY (company_id, qualification_definition_id) REFERENCES hrms_qualification_definitions(company_id, id),
  CONSTRAINT fk_hrqr_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3g. Role experience requirements -------------------------------------
-- Not a definition master: an experience requirement is a sentence about years
-- in an area ("3 years in flexible packaging printing"), and there is nothing
-- reusable to factor out. Several rows per role are normal — one REQUIRED
-- general, one PREFERRED specialist.

CREATE TABLE IF NOT EXISTS hrms_role_experience_requirements (
  id                INT          AUTO_INCREMENT PRIMARY KEY,
  company_id        INT          NOT NULL,
  role_id           INT          NOT NULL,
  min_years         DECIMAL(4,1) NULL,
  preferred_years   DECIMAL(4,1) NULL,
  experience_area   VARCHAR(250) NULL,     -- e.g. flexible packaging printing
  requirement_level ENUM('REQUIRED','PREFERRED') NOT NULL DEFAULT 'REQUIRED',
  notes             TEXT         NULL,
  sequence          INT          NOT NULL DEFAULT 0,
  effective_from    DATE         NULL,
  effective_to      DATE         NULL,

  deleted_at        DATETIME     DEFAULT NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT          NULL,

  UNIQUE KEY uq_hrxr_tenant (company_id, id),
  KEY idx_hrxr_role (company_id, role_id, sequence),
  KEY idx_hrxr_eff  (company_id, role_id, effective_from, effective_to),

  CONSTRAINT fk_hrxr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrxr_role    FOREIGN KEY (company_id, role_id) REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrxr_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3h. Role authority assignments ---------------------------------------
-- `limit_json` holds amount / scope / condition together, e.g.
--     {"amount": 50000, "currency": "INR", "scope": "consumables",
--      "condition": "with QC sign-off"}
-- as JSON rather than three columns because the meaningful limit differs by
-- authority_type: a FINANCIAL authority has an amount, a STOP authority has a
-- scope ("any line in Printing"), and an ESCALATE authority has a condition.
-- Three columns would leave two NULL on every row and still not fit the fourth
-- kind that arrives next year.

CREATE TABLE IF NOT EXISTS hrms_role_authority_assignments (
  id                      INT       AUTO_INCREMENT PRIMARY KEY,
  company_id              INT       NOT NULL,
  role_id                 INT       NOT NULL,
  authority_definition_id INT       NOT NULL,
  limit_json              JSON      NULL,     -- amount / scope / condition
  sequence                INT       NOT NULL DEFAULT 0,
  notes                   TEXT      NULL,
  effective_from          DATE      NULL,
  effective_to            DATE      NULL,

  deleted_at              DATETIME  DEFAULT NULL,
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by              INT       NULL,

  auth_active             INT       GENERATED ALWAYS AS (IF(deleted_at IS NULL, authority_definition_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrau_tenant (company_id, id),
  UNIQUE KEY uq_hrau_pair   (company_id, role_id, auth_active),
  KEY idx_hrau_role (company_id, role_id, sequence),
  KEY idx_hrau_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrau_def  (company_id, authority_definition_id),

  CONSTRAINT fk_hrau_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrau_role    FOREIGN KEY (company_id, role_id)                 REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrau_def     FOREIGN KEY (company_id, authority_definition_id) REFERENCES hrms_authority_definitions(company_id, id),
  CONSTRAINT fk_hrau_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3i. Role relationship expectations -----------------------------------
-- JD-facing "who this role works with and why" — QC, vendors, customers. This is
-- NOT reporting. Nothing in this table feeds the org chart, no manager is named,
-- and `counterparty` is free text on purpose: an EXTERNAL counterparty is
-- usually a category ("transporters"), not a row in this system.
--
-- Keeping it separate from the two reporting tables is what stops a JD sentence
-- from quietly becoming a management line.

CREATE TABLE IF NOT EXISTS hrms_role_relationship_expectations (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  role_id            INT          NOT NULL,
  relationship_scope ENUM('INTERNAL','EXTERNAL') NOT NULL DEFAULT 'INTERNAL',
  counterparty       VARCHAR(250) NOT NULL,   -- e.g. QC, Vendors, Customers
  purpose            TEXT         NULL,
  sequence           INT          NOT NULL DEFAULT 0,
  effective_from     DATE         NULL,
  effective_to       DATE         NULL,

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  UNIQUE KEY uq_hrre_tenant (company_id, id),
  KEY idx_hrre_role  (company_id, role_id, sequence),
  KEY idx_hrre_eff   (company_id, role_id, effective_from, effective_to),
  KEY idx_hrre_scope (company_id, relationship_scope),

  CONSTRAINT fk_hrre_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrre_role    FOREIGN KEY (company_id, role_id) REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrre_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 3j. Role working conditions ------------------------------------------
-- Shift pattern, physical demands, environment, PPE, travel — structured so the
-- JD's safety section is generated rather than remembered. `is_mandatory`
-- separates "must wear ear protection" from "occasional travel".

CREATE TABLE IF NOT EXISTS hrms_role_working_conditions (
  id             INT        AUTO_INCREMENT PRIMARY KEY,
  company_id     INT        NOT NULL,
  role_id        INT        NOT NULL,
  condition_type ENUM('SHIFT','PHYSICAL','ENVIRONMENT','PPE','TRAVEL','OTHER') NOT NULL DEFAULT 'OTHER',
  description    TEXT       NOT NULL,
  is_mandatory   TINYINT(1) NOT NULL DEFAULT 1,
  sequence       INT        NOT NULL DEFAULT 0,
  effective_from DATE       NULL,
  effective_to   DATE       NULL,

  deleted_at     DATETIME   DEFAULT NULL,
  created_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT        NULL,

  UNIQUE KEY uq_hrwc_tenant (company_id, id),
  KEY idx_hrwc_role (company_id, role_id, sequence),
  KEY idx_hrwc_eff  (company_id, role_id, effective_from, effective_to),
  KEY idx_hrwc_type (company_id, condition_type),

  CONSTRAINT fk_hrwc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrwc_role    FOREIGN KEY (company_id, role_id) REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hrwc_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 4. POSITIONS — the optional sanctioned slot                             ##
-- ############################################################################
-- A Position answers "where does this sanctioned job sit?" — Printing Operator,
-- Unit 2, Printing department. It is OPTIONAL by design (non-negotiable 5):
-- SMEs have real responsibilities long before they formalise slots, so a Work
-- Assignment may exist with no Position at all. What a Position adds is the
-- FORMAL structure: the org chart, sanctioned headcount and vacancy.
--
-- Vacancy is DERIVED, never stored: sanctioned_headcount minus the count of
-- active work assignments pointing at this position. Storing a filled count
-- would be a second source of truth that drifts the first time someone ends an
-- assignment without touching the position.


-- ----- 4a. Positions --------------------------------------------------------
-- `role_id` is REQUIRED — a slot with no kind of work in it is not a position.
-- `position_title` overrides the role's title for display only ("Printing
-- Operator - Pelican"); the JD still resolves content from the role.
--
-- `sanctioned_headcount` is DECIMAL(8,2) and defaults to 1. Decimal, because the
-- spec allows GROUPED positions — one "Helper" position with headcount 6 rather
-- than six identical positions — and because half a head is how shared
-- allocations get expressed. If the company later moves to one-seat-per-position
-- the value simply stays 1 and no schema changes (spec's own note).
--
-- `default_shift_id` is why hrms_shifts is created in section 1.
--
-- status DRAFT/ACTIVE/FROZEN/CLOSED: FROZEN is a real state (a sanctioned slot
-- a company has decided not to fill this year) and is distinct from CLOSED.
-- Neither is a delete — historical assignments still point here.

CREATE TABLE IF NOT EXISTS hrms_positions (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  company_id           INT           NOT NULL,
  position_code        VARCHAR(50)   NULL,
  role_id              INT           NOT NULL,          -- required
  position_title       VARCHAR(200)  NULL,              -- optional display override
  department_id        INT           NULL,
  location_id          INT           NULL,
  sanctioned_headcount DECIMAL(8,2)  NOT NULL DEFAULT 1,
  default_shift_id     INT           NULL,
  status               ENUM('DRAFT','ACTIVE','FROZEN','CLOSED') NOT NULL DEFAULT 'DRAFT',
  effective_from       DATE          NULL,
  effective_to         DATE          NULL,

  deleted_at           DATETIME      DEFAULT NULL,
  created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT           NULL,

  code_active          VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(position_code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hpos_tenant (company_id, id),
  UNIQUE KEY uq_hpos_code   (company_id, code_active),
  KEY idx_hpos_role   (company_id, role_id),
  KEY idx_hpos_dept   (company_id, department_id),
  KEY idx_hpos_loc    (company_id, location_id),
  KEY idx_hpos_shift  (company_id, default_shift_id),
  -- "which positions are live today" — the org chart's first query.
  KEY idx_hpos_active (company_id, status, effective_from, effective_to),

  CONSTRAINT fk_hpos_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpos_role    FOREIGN KEY (company_id, role_id)          REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hpos_dept    FOREIGN KEY (company_id, department_id)    REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hpos_loc     FOREIGN KEY (company_id, location_id)      REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hpos_shift   FOREIGN KEY (company_id, default_shift_id) REFERENCES hrms_shifts(company_id, id),
  CONSTRAINT fk_hpos_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 4b. Position work contexts -------------------------------------------
-- The machines, lines, areas or projects a position covers. THIS TABLE IS THE
-- ANSWER TO THE SHARED-RESOURCE PROBLEM: the source chart has nine `kind=shared`
-- nodes — one Helper serving several machines — and the naive import clones the
-- position under each machine. Instead: ONE position, many rows here.
--
-- `is_primary` is where the person mostly is, for display and for defaulting a
-- roster. The service allows at most one primary per position; it is not a
-- unique index because "primary" is only meaningful among rows live on a date.

CREATE TABLE IF NOT EXISTS hrms_position_work_contexts (
  id              INT        AUTO_INCREMENT PRIMARY KEY,
  company_id      INT        NOT NULL,
  position_id     INT        NOT NULL,
  work_context_id INT        NOT NULL,
  is_primary      TINYINT(1) NOT NULL DEFAULT 0,
  effective_from  DATE       NULL,
  effective_to    DATE       NULL,
  notes           TEXT       NULL,

  deleted_at      DATETIME   DEFAULT NULL,
  created_at      TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT        NULL,

  context_active  INT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, work_context_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpwc_tenant (company_id, id),
  -- Spec rule: "Unique active pair position_id + work_context_id."
  UNIQUE KEY uq_hpwc_pair   (company_id, position_id, context_active),
  KEY idx_hpwc_position (company_id, position_id),
  KEY idx_hpwc_context  (company_id, work_context_id),
  KEY idx_hpwc_eff      (company_id, effective_from, effective_to),

  CONSTRAINT fk_hpwc_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpwc_position FOREIGN KEY (company_id, position_id)     REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hpwc_context  FOREIGN KEY (company_id, work_context_id) REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_hpwc_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 4c. Position reporting relationships — the FORMAL structure ----------
-- Position to position, typed. This is the org chart's edge list, and it is
-- between POSITIONS rather than people so a vacant slot still has a manager and
-- a manager change does not rewrite everybody's assignment.
--
-- Both ends are hrms_positions. There is no column here that could hold a work
-- context id, so a machine can never be a manager (non-negotiable 3) — the
-- importer's rule "if the parent is a machine node, re-point to the nearest
-- human/role ancestor" exists because the database will not accept anything else.
--
-- SERVICE RULES (no CHECKs in TiDB):
--   * from_position_id != to_position_id — no self-reporting.
--   * For relationship types with is_formal = 1, the graph must stay acyclic.
--     positionService.js walks up from `to` before inserting and rejects a cycle.
--     A CHECK could not have expressed either rule; both need a query.
-- effective_from is NOT NULL here (the spec marks it so): a formal line without
-- a start date cannot be placed in history.

CREATE TABLE IF NOT EXISTS hrms_position_reporting_relationships (
  id                   INT        AUTO_INCREMENT PRIMARY KEY,
  company_id           INT        NOT NULL,
  from_position_id     INT        NOT NULL,   -- the subordinate
  to_position_id       INT        NOT NULL,   -- the manager
  relationship_type_id INT        NOT NULL,
  -- `is_primary` means primary FOR THIS REPORTING LAYER (spec v1.1 §13.3). It
  -- does NOT invalidate a dotted, functional or project manager on the same
  -- position — those are simply other rows. Never collapse this to one manager.
  is_primary           TINYINT(1) NOT NULL DEFAULT 1,

  -- Scope (spec v1.1 §13.2). A manager may hold authority over only part of the
  -- work — "statutory compliance", one machine, one project — without that
  -- carving out a second Role or Position. GENERAL means the whole job.
  scope_type           ENUM('GENERAL','FUNCTION','RESPONSIBILITY','WORK_CONTEXT','PROJECT','OTHER')
                                  NOT NULL DEFAULT 'GENERAL',
  scope_label          VARCHAR(250) NULL,  -- human-readable: 'Statutory compliance'
  scope_work_context_id INT       NULL,    -- structured scope when it is a known machine/area/project

  effective_from       DATE       NOT NULL,
  effective_to         DATE       NULL,
  notes                TEXT       NULL,

  deleted_at           DATETIME   DEFAULT NULL,
  created_at           TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT        NULL,

  to_active            INT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, to_position_id, NULL)) VIRTUAL,
  -- Scope participates in edge identity, so the SAME manager can hold two
  -- differently-scoped relationships of the same type. Without this the unique
  -- key below would reject "CFO, dotted, statutory compliance" the moment
  -- "CFO, dotted, audit" existed — which is precisely what v1.1 §13.2 allows.
  scope_key            VARCHAR(300) GENERATED ALWAYS AS (
                         CONCAT(scope_type, ':', IFNULL(LOWER(TRIM(scope_label)), ''),
                                ':', IFNULL(scope_work_context_id, 0))) VIRTUAL,

  UNIQUE KEY uq_hprr_tenant (company_id, id),
  -- One live edge per (subordinate, manager, type, scope). A change of dates
  -- ends the row and adds the next; it never becomes a duplicate chart edge.
  UNIQUE KEY uq_hprr_edge   (company_id, from_position_id, to_active, relationship_type_id, scope_key),
  KEY idx_hprr_from (company_id, from_position_id, effective_from, effective_to),
  KEY idx_hprr_to   (company_id, to_position_id, effective_from, effective_to),
  KEY idx_hprr_type (company_id, relationship_type_id),
  KEY idx_hprr_scope_ctx (company_id, scope_work_context_id),

  CONSTRAINT fk_hprr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hprr_from    FOREIGN KEY (company_id, from_position_id)     REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hprr_to      FOREIGN KEY (company_id, to_position_id)       REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hprr_type    FOREIGN KEY (company_id, relationship_type_id) REFERENCES hrms_reporting_relationship_types(company_id, id),
  CONSTRAINT fk_hprr_scope   FOREIGN KEY (company_id, scope_work_context_id) REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_hprr_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 4d. Position content overrides — the middle layer of resolution ------
-- (Non-negotiable 6, layer 2 of 3.) A Position may ADD to, OVERRIDE or SUPPRESS
-- the content its Role carries, for a genuine contextual difference — "this
-- Printing Operator slot on Pelican also owns ink reconciliation". It is NOT a
-- place to copy role content into; contentResolver.js applies SUPPRESS, then
-- OVERRIDE, then ADD, in that order, and nothing else implements that order.
--
-- THREE NULLABLE DEFINITION FKs, EXACTLY ONE SET. The spec asks for a DB CHECK:
--   CHECK (exactly one of kra_definition_id, responsibility_definition_id,
--          kpi_definition_id is non-null)
-- TiDB v8.5.3 runs with tidb_enable_check_constraint = 0, so a CHECK here would
-- be documentation that looks like a guarantee — the worst kind. The rule is
-- enforced instead by contentOverrideService.js (used by both this table and
-- hrms_work_assignment_content_overrides), which rejects a row with zero or more
-- than one definition FK set and also rejects one whose content_type disagrees
-- with which FK is set. Nothing writes these tables except that service.
--
-- `override_json` carries what the OVERRIDE changes — target, weight, class,
-- sequence, text — as JSON, because what is overridable differs by content_type
-- and three sets of typed columns would be mostly NULL on every row.
--
-- `parent_kra_definition_id` groups an ADDed responsibility or KPI under a KRA,
-- so an addition lands in the right JD section instead of "Additional".

CREATE TABLE IF NOT EXISTS hrms_position_content_overrides (
  id                           INT       AUTO_INCREMENT PRIMARY KEY,
  company_id                   INT       NOT NULL,
  position_id                  INT       NOT NULL,
  content_type                 ENUM('KRA','RESPONSIBILITY','KPI') NOT NULL,
  kra_definition_id            INT       NULL,   -- exactly one of these three
  responsibility_definition_id INT       NULL,   -- is set; service-enforced
  kpi_definition_id            INT       NULL,
  action                       ENUM('ADD','OVERRIDE','SUPPRESS') NOT NULL,
  parent_kra_definition_id     INT       NULL,   -- grouping for an ADD
  override_json                JSON      NULL,
  effective_from               DATE      NULL,
  effective_to                 DATE      NULL,
  reason                       TEXT      NULL,   -- why this exception exists

  deleted_at                   DATETIME  DEFAULT NULL,
  created_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by                   INT       NULL,

  UNIQUE KEY uq_hpco_tenant (company_id, id),
  KEY idx_hpco_position (company_id, position_id, content_type),
  KEY idx_hpco_eff      (company_id, position_id, effective_from, effective_to),
  KEY idx_hpco_kra      (company_id, kra_definition_id),
  KEY idx_hpco_resp     (company_id, responsibility_definition_id),
  KEY idx_hpco_kpi      (company_id, kpi_definition_id),
  KEY idx_hpco_parent   (company_id, parent_kra_definition_id),

  CONSTRAINT fk_hpco_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpco_position FOREIGN KEY (company_id, position_id)                  REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hpco_kra      FOREIGN KEY (company_id, kra_definition_id)            REFERENCES hrms_kra_definitions(company_id, id),
  CONSTRAINT fk_hpco_resp     FOREIGN KEY (company_id, responsibility_definition_id) REFERENCES hrms_responsibility_definitions(company_id, id),
  CONSTRAINT fk_hpco_kpi      FOREIGN KEY (company_id, kpi_definition_id)            REFERENCES hrms_kpi_definitions(company_id, id),
  CONSTRAINT fk_hpco_parent   FOREIGN KEY (company_id, parent_kra_definition_id)     REFERENCES hrms_kra_definitions(company_id, id),
  CONSTRAINT fk_hpco_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 5. PEOPLE                                                               ##
-- ############################################################################
-- One row per person, whatever they do and however many jobs they hold
-- (non-negotiables 1 and 2). There is no manager_id and no position_id on this
-- table, and adding either later would re-introduce exactly the model this app
-- exists to replace.


-- ----- 5a. Employees --------------------------------------------------------
-- `user_id` IS THE PLATFORM ADAPTATION (plan §3). Most of the 43 people at Karni
-- will never log in — an employee is an HR record, not an account. The few who
-- approve leave or a regularisation need a login, and platform audit rows
-- reference users.id while HR rows reference employees.id. So both exist and the
-- link between them is OPTIONAL and one-directional.
--   * The FK is a PLAIN FK to users(id), not a composite one, because `users`
--     has no (company_id, id) unique key to point at.
--   * peopleService.js therefore checks that the linked user's company_id equals
--     the employee's. That check is the only thing standing between this column
--     and a cross-tenant link — do not write this column outside that service.
--
-- PHOTO BYTES LIVE IN THE ROW, not on disk. The backend runs on Render's free
-- plan with no persistent disk, so anything written to local storage is lost on
-- every deploy and spin-down. Same decision, same column shape, as
-- fab_item_drawings: `photo_storage` says which world the bytes are in ('db' =
-- DEFLATE-compressed in `photo_content`, 's3' = fetch `photo_uri`), so when
-- object storage arrives new rows simply carry a uri and nothing migrates.
-- `photo_size_bytes` is the size AS UPLOADED, before compression — the number
-- the user recognises. TiDB caps a single row near 6 MB, so the service enforces
-- a ceiling well under that and rejects a large file with a clear message rather
-- than failing on commit with an opaque one.
--
-- employment_status ACTIVE/NOTICE/INACTIVE/EXITED. EXITED is not a delete: an
-- exited employee still owns their attendance history, their generated profile
-- and their assignments' end dates.

CREATE TABLE IF NOT EXISTS hrms_employees (
  id                      INT          AUTO_INCREMENT PRIMARY KEY,
  company_id              INT          NOT NULL,
  employee_code           VARCHAR(50)  NOT NULL,
  full_name               VARCHAR(200) NOT NULL,
  date_of_birth           DATE         NULL,
  gender                  VARCHAR(40)  NULL,        -- free label, configurable
  phone                   VARCHAR(40)  NULL,
  email                   VARCHAR(200) NULL,
  address_json            JSON         NULL,
  emergency_contact_json  JSON         NULL,

  -- Photo, stored as bytes (see the note above).
  photo_file_name         VARCHAR(255) NULL,
  photo_mime_type         VARCHAR(100) NULL,
  photo_size_bytes        INT          NULL,        -- as uploaded, pre-compression
  photo_storage           VARCHAR(16)  NULL,        -- 'db' | 's3'
  photo_compression       VARCHAR(16)  NULL,        -- 'deflate' | NULL
  photo_content           LONGBLOB     NULL,
  photo_uri               VARCHAR(1024) NULL,

  date_of_joining         DATE         NOT NULL,
  employment_type         ENUM('EMPLOYEE','CONTRACT','TRAINEE','CONSULTANT','OTHER') NOT NULL DEFAULT 'EMPLOYEE',
  contractor_id           INT          NULL,        -- set when employment_type = CONTRACT
  employment_status       ENUM('ACTIVE','NOTICE','INACTIVE','EXITED') NOT NULL DEFAULT 'ACTIVE',
  exit_date               DATE         NULL,
  user_id                 INT          NULL,        -- optional platform login

  deleted_at              DATETIME     DEFAULT NULL,
  created_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by              INT          NULL,

  code_active             VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(employee_code), NULL)) VIRTUAL,
  user_active             INT          GENERATED ALWAYS AS (IF(deleted_at IS NULL, user_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hemp_tenant (company_id, id),
  UNIQUE KEY uq_hemp_code   (company_id, code_active),
  -- A platform login belongs to at most one employee. Without this, two employee
  -- rows could both claim the same approver and "who approved this" would be
  -- ambiguous.
  UNIQUE KEY uq_hemp_user   (company_id, user_active),
  KEY idx_hemp_status     (company_id, employment_status),
  KEY idx_hemp_name       (company_id, full_name),
  KEY idx_hemp_contractor (company_id, contractor_id),
  KEY idx_hemp_joining    (company_id, date_of_joining),

  CONSTRAINT fk_hemp_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hemp_contractor FOREIGN KEY (company_id, contractor_id) REFERENCES hrms_contractors(company_id, id),
  CONSTRAINT fk_hemp_user       FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_hemp_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 5b. Employee identifiers ---------------------------------------------
-- AADHAAR, PAN, UAN, ESI and the rest, kept out of hrms_employees so the common
-- read of an employee does not drag statutory numbers around with it.
--
-- `identifier_type` is VARCHAR, not an ENUM: statutory identifiers differ by
-- country and change by statute, and an ENUM would make adding one an ALTER on
-- a live table. The frontend offers a picker seeded from what exists.
--
-- PII: `identifier_value` is MASKED ON READ unless the caller holds
-- cf_hrms_people_pii. That masking happens in peopleService.js, and it is the
-- reason identifiers are a separate resource in resourceDef.json — a screen that
-- lists employees never joins this table, so it cannot leak what it never selects.
-- The value is stored in the clear for now (V1); encryption at rest would need
-- key management this platform does not yet have, and a fake encryption column
-- would be worse than an honest one.
--
-- valid_from / valid_to exist because a person's PAN can be reissued; the old
-- row is ended rather than overwritten, like every other dated row here.

CREATE TABLE IF NOT EXISTS hrms_employee_identifiers (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  employee_id      INT          NOT NULL,
  identifier_type  VARCHAR(50)  NOT NULL,     -- AADHAAR / PAN / UAN / ESI / ...
  identifier_value VARCHAR(200) NOT NULL,     -- masked on read without the PII permission
  is_verified      TINYINT(1)   NOT NULL DEFAULT 0,
  valid_from       DATE         NULL,
  valid_to         DATE         NULL,

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  value_active     VARCHAR(200) GENERATED ALWAYS AS (IF(deleted_at IS NULL, UPPER(identifier_value), NULL)) VIRTUAL,

  UNIQUE KEY uq_heid_tenant (company_id, id),
  -- The same number twice for the same person and type is always a mistake.
  -- Two rows of the SAME type with different values are allowed on purpose —
  -- that is a reissue, with the old one closed by valid_to.
  UNIQUE KEY uq_heid_value  (company_id, employee_id, identifier_type, value_active),
  KEY idx_heid_employee (company_id, employee_id),
  KEY idx_heid_type     (company_id, identifier_type),

  CONSTRAINT fk_heid_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_heid_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_heid_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 5c. Employee documents -----------------------------------------------
-- Joining letters, statutory forms, certificates, licences — with their issue
-- and expiry dates and a verification state, because an expired safety licence
-- is an operational fact and not a filing problem.
--
-- BYTES IN THE ROW, same shape and same reason as hrms_employees.photo and
-- fab_item_drawings: Render's free plan has no persistent disk. `storage` = 'db'
-- means DEFLATE-compressed bytes in `content`; 's3' means fetch `uri` and leave
-- `content` NULL. Both kinds read through one endpoint, so nothing migrates when
-- object storage arrives. `size_bytes` is the pre-compression size.
--
-- `verified_by_employee_id` points at an EMPLOYEE, not a user: the person who
-- checked the original is an HR person in the org chart, and they may not have a
-- login at all.

CREATE TABLE IF NOT EXISTS hrms_employee_documents (
  id                      INT           AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  employee_id             INT           NOT NULL,
  document_type           VARCHAR(100)  NOT NULL,
  title                   VARCHAR(250)  NULL,

  file_name               VARCHAR(255)  NOT NULL,
  mime_type               VARCHAR(100)  NOT NULL DEFAULT 'application/pdf',
  size_bytes              INT           NOT NULL,       -- as uploaded, pre-compression
  storage                 VARCHAR(16)   NOT NULL DEFAULT 'db',   -- 'db' | 's3'
  compression             VARCHAR(16)   NULL DEFAULT 'deflate',
  content                 LONGBLOB      NULL,
  uri                     VARCHAR(1024) NULL,

  issue_date              DATE          NULL,
  expiry_date             DATE          NULL,
  verification_status     ENUM('UNVERIFIED','VERIFIED','REJECTED') NOT NULL DEFAULT 'UNVERIFIED',
  verified_by_employee_id INT           NULL,
  verified_at             TIMESTAMP     NULL,
  notes                   TEXT          NULL,

  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by              INT           NULL,

  UNIQUE KEY uq_hedo_tenant (company_id, id),
  KEY idx_hedo_employee (company_id, employee_id, document_type),
  -- "what expires in the next 30 days" — the only query this table owes a screen.
  KEY idx_hedo_expiry   (company_id, expiry_date),
  KEY idx_hedo_status   (company_id, verification_status),
  KEY idx_hedo_verifier (company_id, verified_by_employee_id),

  CONSTRAINT fk_hedo_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hedo_employee FOREIGN KEY (company_id, employee_id)             REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hedo_verifier FOREIGN KEY (company_id, verified_by_employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hedo_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 5d. Employment events ------------------------------------------------
-- The human-readable timeline: joined, transferred, changed assignment,
-- changed department, changed contractor, exited. `summary` is the sentence a
-- person reads; `details_json` holds the before/after for anyone who needs it.
--
-- This is NOT hrms_audit_log. The audit log records that a row changed, for
-- governance; this records that something happened TO A PERSON, for their file.
-- One is written by every service; this one is written deliberately.
--
-- FORWARD REFERENCE: `work_assignment_id` points at hrms_work_assignments, which
-- is created in section 6. The column is declared here (the spec puts events
-- with People) and its FK is added by a guarded ALTER in section 6e, once the
-- target table exists. This is the one ordering conflict in the file.

CREATE TABLE IF NOT EXISTS hrms_employment_events (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  employee_id        INT          NOT NULL,
  event_type         ENUM('JOIN','TRANSFER','ASSIGNMENT_CHANGE','DEPARTMENT_CHANGE','CONTRACTOR_CHANGE','EXIT','OTHER') NOT NULL,
  event_date         DATE         NOT NULL,
  work_assignment_id INT          NULL,      -- FK added in section 6e
  summary            VARCHAR(300) NOT NULL,
  details_json       JSON         NULL,      -- before / after / details

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  UNIQUE KEY uq_heev_tenant (company_id, id),
  KEY idx_heev_employee   (company_id, employee_id, event_date),
  KEY idx_heev_type       (company_id, event_type, event_date),
  KEY idx_heev_assignment (company_id, work_assignment_id),

  CONSTRAINT fk_heev_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_heev_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_heev_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 6. WORK ASSIGNMENTS — the centre of the model                           ##
-- ############################################################################
-- Everything above this section exists so that this table can be accurate.
-- A Work Assignment is the record of what ONE PERSON IS ACTUALLY DOING NOW.
-- An employee has 1..n concurrent assignments: Ram Babu is Admin Manager at 60%,
-- HR Executive at 25% and Transport Coordinator at 15% — ONE employee row,
-- THREE assignments, and no duplicated person anywhere.


-- ----- 6a. Work assignments -------------------------------------------------
-- `employee_id` and `role_id` are NOT NULL; `position_id` IS NULL-able
-- (non-negotiable 5). That asymmetry is the whole design: work exists before
-- the slot that sanctions it is drawn.
--
-- `department_id` / `location_id` are explicit here rather than always read
-- through the position, because an assignment with no position still has to say
-- where the work happens, and because an approved exception (a person posted to
-- another unit without a new position) must be recordable without editing the
-- position everyone else shares.
--
-- `allocation_percent` is ADVISORY. Nothing forces an employee's assignments to
-- total 100 — the taxonomy is explicit that this is a company policy choice, not
-- a model rule, and enforcing it would make recording reality impossible during
-- a handover week. assignmentService.js surfaces the total; it does not block.
--
-- `is_primary` picks which assignment supplies defaults for display, the roster
-- and the responsibility profile's header.
--
-- SERVICE RULE (spec): when position_id is set, role_id should normally match
-- positions.role_id. "Normally" is the spec's word — an explicit exception is
-- supported — so this is a warning in assignmentService.js, not a constraint.
--
-- status PLANNED/ACTIVE/SUSPENDED/ENDED, and ENDED rather than deleted: the
-- history is the point (non-negotiable 8). effective_from is NOT NULL.

CREATE TABLE IF NOT EXISTS hrms_work_assignments (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  employee_id        INT           NOT NULL,      -- required
  role_id            INT           NOT NULL,      -- required
  position_id        INT           NULL,          -- OPTIONAL, deliberately
  department_id      INT           NULL,
  location_id        INT           NULL,
  assignment_title   VARCHAR(200)  NULL,          -- optional person-specific title
  allocation_percent DECIMAL(5,2)  NULL,          -- 0-100, advisory
  is_primary         TINYINT(1)    NOT NULL DEFAULT 0,
  default_shift_id   INT           NULL,
  status             ENUM('PLANNED','ACTIVE','SUSPENDED','ENDED') NOT NULL DEFAULT 'ACTIVE',
  effective_from     DATE          NOT NULL,
  effective_to       DATE          NULL,
  reason             VARCHAR(300)  NULL,          -- why it exists / changed

  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  UNIQUE KEY uq_hwas_tenant (company_id, id),
  -- The three queries this table owes every screen:
  --   "this person's current jobs", "who is in this position", "who holds this role".
  KEY idx_hwas_employee (company_id, employee_id, status, effective_from, effective_to),
  KEY idx_hwas_position (company_id, position_id, status, effective_from, effective_to),
  KEY idx_hwas_role     (company_id, role_id, status),
  KEY idx_hwas_dept     (company_id, department_id),
  KEY idx_hwas_loc      (company_id, location_id),
  KEY idx_hwas_shift    (company_id, default_shift_id),
  KEY idx_hwas_active   (company_id, status, effective_from, effective_to),

  CONSTRAINT fk_hwas_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hwas_employee FOREIGN KEY (company_id, employee_id)      REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hwas_role     FOREIGN KEY (company_id, role_id)          REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hwas_position FOREIGN KEY (company_id, position_id)      REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hwas_dept     FOREIGN KEY (company_id, department_id)    REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hwas_loc      FOREIGN KEY (company_id, location_id)      REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hwas_shift    FOREIGN KEY (company_id, default_shift_id) REFERENCES hrms_shifts(company_id, id),
  CONSTRAINT fk_hwas_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 6b. Work assignment contexts -----------------------------------------
-- Which machines / lines / areas / projects this person's assignment covers.
-- Same shape as hrms_position_work_contexts and for the same reason: a helper
-- who covers three machines is one assignment with three rows here, never three
-- assignments.

CREATE TABLE IF NOT EXISTS hrms_work_assignment_contexts (
  id                 INT        AUTO_INCREMENT PRIMARY KEY,
  company_id         INT        NOT NULL,
  work_assignment_id INT        NOT NULL,
  work_context_id    INT        NOT NULL,
  is_primary         TINYINT(1) NOT NULL DEFAULT 0,
  effective_from     DATE       NULL,
  effective_to       DATE       NULL,
  notes              TEXT       NULL,

  deleted_at         DATETIME   DEFAULT NULL,
  created_at         TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT        NULL,

  context_active     INT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, work_context_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hwac_tenant (company_id, id),
  UNIQUE KEY uq_hwac_pair   (company_id, work_assignment_id, context_active),
  KEY idx_hwac_assignment (company_id, work_assignment_id),
  KEY idx_hwac_context    (company_id, work_context_id),
  KEY idx_hwac_eff        (company_id, effective_from, effective_to),

  CONSTRAINT fk_hwac_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hwac_assignment FOREIGN KEY (company_id, work_assignment_id) REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_hwac_context    FOREIGN KEY (company_id, work_context_id)    REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_hwac_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 6c. Assignment reporting relationships — the ACTUAL reporting --------
-- (Non-negotiable 1.) Formal reporting between positions (4c) is the chart.
-- THIS is who a person actually answers to for this piece of work, and it is
-- where the matrix lives: a payroll-only line to the Accounts Head, a functional
-- line to the Plant Head, a project manager for six months.
--
-- `manager_employee_id` is REQUIRED and `manager_work_assignment_id` is optional
-- but strongly preferred — naming the manager's assignment says WHICH HAT the
-- manager is wearing, which is the difference between "reports to Ram Babu" and
-- "reports to Ram Babu as Admin Manager".
--
-- `scope_notes` is the free text that keeps the matrix honest: "payroll only".
-- Without it people invent a relationship type per exception.
--
-- Both ends are employees/assignments. There is no context column here either —
-- a machine cannot be a manager in the actual structure any more than in the
-- formal one.
--
-- SERVICE RULES: an assignment may not report to itself or to another assignment
-- of the same employee; at most one active relationship of a type whose
-- allow_multiple is 0. assignmentService.js enforces both — neither is
-- expressible as a constraint, because both depend on effective dates.

CREATE TABLE IF NOT EXISTS hrms_assignment_reporting_relationships (
  id                         INT        AUTO_INCREMENT PRIMARY KEY,
  company_id                 INT        NOT NULL,
  work_assignment_id         INT        NOT NULL,
  manager_employee_id        INT        NOT NULL,
  manager_work_assignment_id INT        NULL,   -- which hat the manager wears
  relationship_type_id       INT        NOT NULL,
  -- Primary FOR THIS LAYER (spec v1.1 §13.3). A dotted, functional or project
  -- manager on the same assignment stays valid alongside it. The service
  -- returns the resolved SET; it must never flatten this to one manager_id.
  is_primary                 TINYINT(1) NOT NULL DEFAULT 0,

  -- Scope (spec v1.1 §13.2). This is what stops a second manager becoming a
  -- second Role: "CFO, for statutory compliance only" is a scoped row on the
  -- SAME assignment, not a new job. GENERAL means the whole assignment.
  scope_type                 ENUM('GENERAL','FUNCTION','RESPONSIBILITY','WORK_CONTEXT','PROJECT','OTHER')
                                        NOT NULL DEFAULT 'GENERAL',
  scope_label                VARCHAR(250) NULL,
  scope_work_context_id      INT        NULL,
  scope_notes                TEXT       NULL,   -- free-form detail that needs no master

  effective_from             DATE       NOT NULL,
  effective_to               DATE       NULL,

  deleted_at                 DATETIME   DEFAULT NULL,
  created_at                 TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by                 INT        NULL,

  manager_active             INT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, manager_employee_id, NULL)) VIRTUAL,
  -- See the same column on hrms_position_reporting_relationships: scope is part
  -- of an edge's identity, so one manager may hold two differently-scoped
  -- relationships of the same type over the same assignment.
  scope_key                  VARCHAR(300) GENERATED ALWAYS AS (
                               CONCAT(scope_type, ':', IFNULL(LOWER(TRIM(scope_label)), ''),
                                      ':', IFNULL(scope_work_context_id, 0))) VIRTUAL,

  UNIQUE KEY uq_harr_tenant (company_id, id),
  -- One live edge per (assignment, manager, type, scope).
  UNIQUE KEY uq_harr_edge   (company_id, work_assignment_id, manager_active, relationship_type_id, scope_key),
  KEY idx_harr_assignment (company_id, work_assignment_id, effective_from, effective_to),
  KEY idx_harr_manager    (company_id, manager_employee_id, effective_from, effective_to),
  KEY idx_harr_mgr_asgn   (company_id, manager_work_assignment_id),
  KEY idx_harr_type       (company_id, relationship_type_id),
  KEY idx_harr_scope_ctx  (company_id, scope_work_context_id),

  CONSTRAINT fk_harr_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_harr_assignment FOREIGN KEY (company_id, work_assignment_id)         REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_harr_manager    FOREIGN KEY (company_id, manager_employee_id)        REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_harr_mgr_asgn   FOREIGN KEY (company_id, manager_work_assignment_id) REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_harr_type       FOREIGN KEY (company_id, relationship_type_id)       REFERENCES hrms_reporting_relationship_types(company_id, id),
  CONSTRAINT fk_harr_scope      FOREIGN KEY (company_id, scope_work_context_id)      REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_harr_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 6d. Work assignment content overrides — layer 3 of resolution --------
-- (Non-negotiable 6, the last overlay.) Same shape and same three-FK rule as
-- hrms_position_content_overrides, enforced by the same contentOverrideService.js:
-- exactly one of kra_definition_id / responsibility_definition_id /
-- kpi_definition_id is set, and it must agree with content_type. No CHECK — TiDB
-- runs with tidb_enable_check_constraint = 0.
--
-- USE SPARINGLY. The spec says so and it is worth repeating: this table is for
-- what is genuinely true of ONE PERSON'S assignment and not of the role — a
-- temporary additional duty, a suppressed responsibility during training. Normal
-- content belongs on the Role. A company that fills this table is describing
-- roles it has not yet defined, and every JD for that role will be wrong.

CREATE TABLE IF NOT EXISTS hrms_work_assignment_content_overrides (
  id                           INT       AUTO_INCREMENT PRIMARY KEY,
  company_id                   INT       NOT NULL,
  work_assignment_id           INT       NOT NULL,
  content_type                 ENUM('KRA','RESPONSIBILITY','KPI') NOT NULL,
  kra_definition_id            INT       NULL,   -- exactly one of these three
  responsibility_definition_id INT       NULL,   -- is set; service-enforced
  kpi_definition_id            INT       NULL,
  action                       ENUM('ADD','OVERRIDE','SUPPRESS') NOT NULL,
  parent_kra_definition_id     INT       NULL,
  override_json                JSON      NULL,
  effective_from               DATE      NULL,
  effective_to                 DATE      NULL,
  reason                       TEXT      NULL,

  deleted_at                   DATETIME  DEFAULT NULL,
  created_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by                   INT       NULL,

  UNIQUE KEY uq_hwco_tenant (company_id, id),
  KEY idx_hwco_assignment (company_id, work_assignment_id, content_type),
  KEY idx_hwco_eff        (company_id, work_assignment_id, effective_from, effective_to),
  KEY idx_hwco_kra        (company_id, kra_definition_id),
  KEY idx_hwco_resp       (company_id, responsibility_definition_id),
  KEY idx_hwco_kpi        (company_id, kpi_definition_id),
  KEY idx_hwco_parent     (company_id, parent_kra_definition_id),

  CONSTRAINT fk_hwco_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hwco_assignment FOREIGN KEY (company_id, work_assignment_id)           REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_hwco_kra        FOREIGN KEY (company_id, kra_definition_id)            REFERENCES hrms_kra_definitions(company_id, id),
  CONSTRAINT fk_hwco_resp       FOREIGN KEY (company_id, responsibility_definition_id) REFERENCES hrms_responsibility_definitions(company_id, id),
  CONSTRAINT fk_hwco_kpi        FOREIGN KEY (company_id, kpi_definition_id)            REFERENCES hrms_kpi_definitions(company_id, id),
  CONSTRAINT fk_hwco_parent     FOREIGN KEY (company_id, parent_kra_definition_id)     REFERENCES hrms_kra_definitions(company_id, id),
  CONSTRAINT fk_hwco_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 6e. The forward FK promised in section 5d ----------------------------
-- hrms_employment_events.work_assignment_id -> hrms_work_assignments. Events sit
-- with People in the spec's grouping, but a work assignment is created two
-- sections later, so this one FK is added after both tables exist. Guarded by an
-- information_schema check, so the file stays safe to re-run.

SET @fk = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'hrms_employment_events'
              AND CONSTRAINT_NAME = 'fk_heev_assignment');
SET @sql = IF(@fk = 0,
  'ALTER TABLE hrms_employment_events ADD CONSTRAINT fk_heev_assignment FOREIGN KEY (company_id, work_assignment_id) REFERENCES hrms_work_assignments(company_id, id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- (The hrms_audit_log READ widening used to sit here. It does not any more —
--  see section 10 at the end of this file, and the note there about why.)


-- ############################################################################
-- ## 7. WORKFORCE — requirement, roster, attendance                          ##
-- ############################################################################
-- Three different numbers that a naive HRMS collapses into one:
--   SANCTIONED headcount — hrms_positions.sanctioned_headcount. What the company
--     has approved as a slot.
--   REQUIRED manpower — hrms_manpower_requirements. What operations actually
--     needs on a shift, on a machine, in a date range. It is routinely higher
--     during a campaign and lower in a lean month, and it is NOT the sanctioned
--     number.
--   ROSTERED / PRESENT — hrms_shift_rosters and hrms_attendance_records.
-- The daily manpower gap is required minus present, per role/position/context/
-- shift; vacancy is sanctioned minus active assignments. Two different questions.


-- ----- 7a. Manpower requirements --------------------------------------------
-- SERVICE RULE (spec): at least one of role_id / position_id must be present —
-- a requirement for nobody in particular is not a requirement. Context and shift
-- may both be NULL for a broad requirement ("we need 4 packers this month").
-- No CHECK; workforceService.js rejects the empty case.
--
-- The org-chart import writes here for the DN (day+night) shift pattern: DN is
-- two shifts' worth of people, not one shift, so it becomes TWO requirement rows
-- rather than one position with an impossible default shift.

CREATE TABLE IF NOT EXISTS hrms_manpower_requirements (
  id              INT          AUTO_INCREMENT PRIMARY KEY,
  company_id      INT          NOT NULL,
  role_id         INT          NULL,      -- at least one of role_id / position_id
  position_id     INT          NULL,
  work_context_id INT          NULL,
  shift_id        INT          NULL,
  required_count  DECIMAL(8,2) NOT NULL DEFAULT 1,
  effective_from  DATE         NOT NULL,
  effective_to    DATE         NULL,
  notes           TEXT         NULL,

  deleted_at      DATETIME     DEFAULT NULL,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT          NULL,

  UNIQUE KEY uq_hmrq_tenant (company_id, id),
  KEY idx_hmrq_role     (company_id, role_id, effective_from, effective_to),
  KEY idx_hmrq_position (company_id, position_id, effective_from, effective_to),
  KEY idx_hmrq_context  (company_id, work_context_id),
  KEY idx_hmrq_shift    (company_id, shift_id),
  KEY idx_hmrq_window   (company_id, effective_from, effective_to),

  CONSTRAINT fk_hmrq_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hmrq_role     FOREIGN KEY (company_id, role_id)         REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hmrq_position FOREIGN KEY (company_id, position_id)     REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hmrq_context  FOREIGN KEY (company_id, work_context_id) REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_hmrq_shift    FOREIGN KEY (company_id, shift_id)        REFERENCES hrms_shifts(company_id, id),
  CONSTRAINT fk_hmrq_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 7b. Shift rosters ----------------------------------------------------
-- Which shift a person's ASSIGNMENT works on a given date. Roster is assignment-
-- level (not employee-level) because that is where the work context and the
-- default shift live — a person with two assignments can be on the Pelican
-- machine on days and doing safety rounds on generals.
--
-- `source` records where the row came from — DEFAULT (materialised from the
-- assignment's default_shift_id), MANUAL, IMPORT or PLANNING — so a regenerate
-- can safely overwrite DEFAULT rows and never touch a MANUAL one.
--
-- Spec rule: unique work_assignment_id + roster_date, "unless split shifts are
-- explicitly enabled". They are not in V1; if they ever are, this unique key is
-- the single thing that has to change, which is why it is stated here in one
-- place rather than assumed in the service.

CREATE TABLE IF NOT EXISTS hrms_shift_rosters (
  id                 INT       AUTO_INCREMENT PRIMARY KEY,
  company_id         INT       NOT NULL,
  work_assignment_id INT       NOT NULL,
  roster_date        DATE      NOT NULL,
  shift_id           INT       NOT NULL,
  work_context_id    INT       NULL,
  source             ENUM('DEFAULT','MANUAL','IMPORT','PLANNING') NOT NULL DEFAULT 'DEFAULT',
  notes              TEXT      NULL,

  deleted_at         DATETIME  DEFAULT NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT       NULL,

  date_active        DATE      GENERATED ALWAYS AS (IF(deleted_at IS NULL, roster_date, NULL)) VIRTUAL,

  UNIQUE KEY uq_hros_tenant (company_id, id),
  UNIQUE KEY uq_hros_day    (company_id, work_assignment_id, date_active),
  -- "the whole plant on this date" — the roster screen's only query.
  KEY idx_hros_date       (company_id, roster_date, shift_id),
  KEY idx_hros_assignment (company_id, work_assignment_id, roster_date),
  KEY idx_hros_context    (company_id, work_context_id, roster_date),

  CONSTRAINT fk_hros_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hros_assignment FOREIGN KEY (company_id, work_assignment_id) REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_hros_shift      FOREIGN KEY (company_id, shift_id)           REFERENCES hrms_shifts(company_id, id),
  CONSTRAINT fk_hros_context    FOREIGN KEY (company_id, work_context_id)    REFERENCES hrms_work_contexts(company_id, id),
  CONSTRAINT fk_hros_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 7c. Attendance records -----------------------------------------------
-- ###########################################################################
-- ## ONE ATTENDANCE ROW PER PERSON PER DAY PER SHIFT. NOT ONE PER ROLE.    ##
-- ###########################################################################
-- This is the rule the whole workforce section exists to protect, and it is the
-- single easiest thing to get wrong in this app. A person who holds three work
-- assignments was present ONCE. If a second row appears because they hold a
-- second role, then every headcount, every manpower gap and every leave balance
-- in the system is inflated, and nothing downstream will tell you why.
--
-- Attendance therefore keys on EMPLOYEE, not on assignment:
--   UNIQUE (company_id, employee_id, attendance_date, shift_id)
-- `work_assignment_id` on this table is OPTIONAL OPERATIONAL ATTRIBUTION ONLY —
-- "the hours this person worked are attributed to the Pelican assignment". It is
-- NOT part of the key, it must never be used to justify a second row for the
-- same person and day, and a screen that groups attendance by assignment is
-- reporting an attribution, not counting people.
--
-- If split shifts are ever enabled, a person can legitimately have two rows for
-- one date with DIFFERENT shift_id values — that is why shift_id is in the key.
-- `shift_key` exists because shift_id is nullable (attendance can be recorded
-- before a roster exists) and MySQL does not compare NULLs in a unique index; it
-- maps "no shift" to 0 so the duplicate is still caught.
--
-- in_time / out_time are TIMESTAMPs, not TIMEs: a night shift's out_time is the
-- next calendar day, and storing a bare time there is how night-shift hours get
-- silently computed as negative.
--
-- `source` distinguishes a biometric punch from a manual entry from an import,
-- because a correction has to know what it is correcting. Corrections themselves
-- do NOT overwrite this row — see 7d.

CREATE TABLE IF NOT EXISTS hrms_attendance_records (
  id                 INT       AUTO_INCREMENT PRIMARY KEY,
  company_id         INT       NOT NULL,
  employee_id        INT       NOT NULL,       -- the key is the PERSON
  attendance_date    DATE      NOT NULL,
  shift_id           INT       NULL,
  status             ENUM('PRESENT','ABSENT','LEAVE','WEEKLY_OFF','HOLIDAY','HALF_DAY','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  in_time            TIMESTAMP NULL,
  out_time           TIMESTAMP NULL,
  source             ENUM('BIOMETRIC','MANUAL','IMPORT','SYSTEM') NOT NULL DEFAULT 'MANUAL',
  work_assignment_id INT       NULL,           -- ATTRIBUTION ONLY. Never a second row.
  notes              TEXT      NULL,

  deleted_at         DATETIME  DEFAULT NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT       NULL,

  shift_key          INT       GENERATED ALWAYS AS (IFNULL(shift_id, 0)) VIRTUAL,
  date_active        DATE      GENERATED ALWAYS AS (IF(deleted_at IS NULL, attendance_date, NULL)) VIRTUAL,

  UNIQUE KEY uq_hatr_tenant (company_id, id),
  UNIQUE KEY uq_hatr_day    (company_id, employee_id, date_active, shift_key),
  -- "the whole plant on this date" and "this person's month".
  KEY idx_hatr_date       (company_id, attendance_date, status),
  KEY idx_hatr_employee   (company_id, employee_id, attendance_date),
  KEY idx_hatr_shift      (company_id, shift_id, attendance_date),
  KEY idx_hatr_assignment (company_id, work_assignment_id),

  CONSTRAINT fk_hatr_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hatr_employee   FOREIGN KEY (company_id, employee_id)        REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hatr_shift      FOREIGN KEY (company_id, shift_id)           REFERENCES hrms_shifts(company_id, id),
  CONSTRAINT fk_hatr_assignment FOREIGN KEY (company_id, work_assignment_id) REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_hatr_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 7d. Attendance regularizations ---------------------------------------
-- A correction is a REQUEST against an attendance row, not an edit of it. The
-- original state stays visible, which is the whole point of the spec calling
-- this "audit-safe": "he was marked absent and it was changed" must remain
-- readable after the change.
--
-- On APPROVED, workforceService.js applies requested_status / requested_in_time /
-- requested_out_time to the attendance row AND writes an hrms_audit_log entry.
-- The approval is the only path that edits an attendance row after the fact.
--
-- requested_by / reviewed_by are EMPLOYEES: the requester is usually a worker
-- with no login, and the reviewer is a manager in the org chart. The platform
-- user who clicked approve is captured separately in hrms_audit_log.actor_user_id.

CREATE TABLE IF NOT EXISTS hrms_attendance_regularizations (
  id                       INT       AUTO_INCREMENT PRIMARY KEY,
  company_id               INT       NOT NULL,
  attendance_record_id     INT       NOT NULL,
  requested_by_employee_id INT       NULL,
  requested_status         ENUM('PRESENT','ABSENT','LEAVE','WEEKLY_OFF','HOLIDAY','HALF_DAY','UNKNOWN') NULL,
  requested_in_time        TIMESTAMP NULL,
  requested_out_time       TIMESTAMP NULL,
  reason                   TEXT      NOT NULL,
  status                   ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  reviewed_by_employee_id  INT       NULL,
  reviewed_at              TIMESTAMP NULL,

  deleted_at               DATETIME  DEFAULT NULL,
  created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by               INT       NULL,

  UNIQUE KEY uq_hreg_tenant (company_id, id),
  KEY idx_hreg_record    (company_id, attendance_record_id),
  KEY idx_hreg_status    (company_id, status, created_at),
  KEY idx_hreg_requester (company_id, requested_by_employee_id),
  KEY idx_hreg_reviewer  (company_id, reviewed_by_employee_id),

  CONSTRAINT fk_hreg_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hreg_record    FOREIGN KEY (company_id, attendance_record_id)     REFERENCES hrms_attendance_records(company_id, id),
  CONSTRAINT fk_hreg_requester FOREIGN KEY (company_id, requested_by_employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hreg_reviewer  FOREIGN KEY (company_id, reviewed_by_employee_id)  REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hreg_creator   FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 8. LEAVE                                                                ##
-- ############################################################################
-- Leave is EMPLOYEE-level, like attendance and for the same reason: a person
-- takes a day off, not a role. Approved leave feeds the attendance status for
-- the affected dates — leaveService.js writes/updates the attendance rows on
-- approval, which is why hrms_attendance_records.status carries a LEAVE value
-- rather than leave living in a parallel universe the attendance screen cannot see.


-- ----- 8a. Leave types ------------------------------------------------------
-- `unit` DAY / HALF_DAY / HOUR decides what `quantity` on a request MEANS, and
-- what a balance counts in. Mixing units inside one type is how balances become
-- unauditable, so the unit is on the type and never on the request.
-- `annual_entitlement` is the simple V1 accrual: a number per period, no policy
-- engine. Accrual rules, carry-forward and encashment are explicitly out of V1.

CREATE TABLE IF NOT EXISTS hrms_leave_types (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  code               VARCHAR(50)   NOT NULL,
  name               VARCHAR(100)  NOT NULL,
  unit               ENUM('DAY','HALF_DAY','HOUR') NOT NULL DEFAULT 'DAY',
  annual_entitlement DECIMAL(8,2)  NULL,
  is_paid            TINYINT(1)    NOT NULL DEFAULT 1,
  status             ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  code_active        VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hlvt_tenant (company_id, id),
  UNIQUE KEY uq_hlvt_code   (company_id, code_active),
  KEY idx_hlvt_status (company_id, status),

  CONSTRAINT fk_hlvt_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlvt_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 8b. Leave balances ---------------------------------------------------
-- One row per employee per leave type per period. `period_key` is a VARCHAR
-- ('2026', '2026-27', '2026-Q1') rather than a year integer, because Indian SMEs
-- run leave on a financial year as often as a calendar one and the shape of the
-- period is a company decision, not a schema one.
--
-- opening + accrued - used + adjusted = closing. `closing_balance` is STORED
-- rather than derived on read: it is what a payslip or a letter quotes, and the
-- four inputs can be edited by an adjustment months later. leaveService.js
-- recomputes it on every write to the row — it is a cache with exactly one writer.

CREATE TABLE IF NOT EXISTS hrms_leave_balances (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  employee_id     INT           NOT NULL,
  leave_type_id   INT           NOT NULL,
  period_key      VARCHAR(20)   NOT NULL,     -- e.g. '2026' or '2026-27'
  opening_balance DECIMAL(8,2)  NOT NULL DEFAULT 0,
  accrued         DECIMAL(8,2)  NOT NULL DEFAULT 0,
  used            DECIMAL(8,2)  NOT NULL DEFAULT 0,
  adjusted        DECIMAL(8,2)  NOT NULL DEFAULT 0,
  closing_balance DECIMAL(8,2)  NOT NULL DEFAULT 0,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  period_active   VARCHAR(20)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, period_key, NULL)) VIRTUAL,

  UNIQUE KEY uq_hlvb_tenant (company_id, id),
  UNIQUE KEY uq_hlvb_period (company_id, employee_id, leave_type_id, period_active),
  KEY idx_hlvb_employee (company_id, employee_id, period_key),
  KEY idx_hlvb_type     (company_id, leave_type_id),

  CONSTRAINT fk_hlvb_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlvb_employee FOREIGN KEY (company_id, employee_id)   REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hlvb_type     FOREIGN KEY (company_id, leave_type_id) REFERENCES hrms_leave_types(company_id, id),
  CONSTRAINT fk_hlvb_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 8c. Leave requests ---------------------------------------------------
-- DRAFT -> PENDING -> APPROVED / REJECTED / CANCELLED. On APPROVED, the service
-- writes the attendance rows for from_date..to_date with status LEAVE and moves
-- `used` on the balance; on CANCELLED after approval it reverses both. Those two
-- side effects are the reason leave is not a standalone list.
--
-- `approver_employee_id` is an employee, like everywhere else in this app: the
-- approving manager exists in the org chart whether or not they have a login.

CREATE TABLE IF NOT EXISTS hrms_leave_requests (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  company_id           INT           NOT NULL,
  employee_id          INT           NOT NULL,
  leave_type_id        INT           NOT NULL,
  from_date            DATE          NOT NULL,
  to_date              DATE          NOT NULL,
  quantity             DECIMAL(8,2)  NOT NULL DEFAULT 1,   -- in the type's unit
  reason               TEXT          NULL,
  status               ENUM('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  approver_employee_id INT           NULL,
  approved_at          TIMESTAMP     NULL,

  deleted_at           DATETIME      DEFAULT NULL,
  created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT           NULL,

  UNIQUE KEY uq_hlvr_tenant (company_id, id),
  KEY idx_hlvr_employee (company_id, employee_id, from_date, to_date),
  KEY idx_hlvr_status   (company_id, status, from_date),
  KEY idx_hlvr_type     (company_id, leave_type_id),
  KEY idx_hlvr_approver (company_id, approver_employee_id, status),

  CONSTRAINT fk_hlvr_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlvr_employee FOREIGN KEY (company_id, employee_id)          REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hlvr_type     FOREIGN KEY (company_id, leave_type_id)        REFERENCES hrms_leave_types(company_id, id),
  CONSTRAINT fk_hlvr_approver FOREIGN KEY (company_id, approver_employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hlvr_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 9. DOCUMENTS, HISTORY AND GOVERNANCE                                    ##
-- ############################################################################


-- ----- 9a. Generated documents ----------------------------------------------
-- (Non-negotiable 7.) Two documents come out of this app: a ROLE_JD and an
-- EMPLOYEE_RESPONSIBILITY_PROFILE.
--
-- `snapshot_json` IS NOT NULL, AND THAT IS THE MOST IMPORTANT WORD ON THIS TABLE.
-- It holds every piece of resolved source data the render used — the role, its
-- effective KRAs, responsibilities and KPIs after the position and assignment
-- overlays, the skills, quals, experience, authorities, conditions, the position
-- context and the reporting lines. documentService.js writes the snapshot BEFORE
-- it renders the file, and a historical document is re-rendered FROM ITS OWN
-- SNAPSHOT, never from today's role. Without this, a JD signed in March silently
-- becomes a different document in November and nobody can prove what was agreed.
--
-- `template_version` records which renderer produced the file, so a template fix
-- can be re-applied to old snapshots deliberately rather than by accident.
--
-- DOCX AND PDF BYTES IN THE ROW, two independent sets of the same columns, same
-- shape and same reason as hrms_employee_documents and fab_item_drawings (no
-- persistent disk on Render's free plan). Either may be NULL: preview-only
-- generations save the snapshot and no file at all, which is still a valid row
-- because the snapshot is the record.
--
-- `is_current` marks the live document for a target. The generated column
-- `current_target` makes "at most one current per (type, role, position,
-- employee)" a database guarantee instead of a service promise: it is NULL for
-- every superseded or deleted row, and MySQL does not compare NULLs.

CREATE TABLE IF NOT EXISTS hrms_generated_documents (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  document_type    ENUM('ROLE_JD','EMPLOYEE_RESPONSIBILITY_PROFILE') NOT NULL,
  role_id          INT           NULL,
  position_id      INT           NULL,
  employee_id      INT           NULL,
  snapshot_json    JSON          NOT NULL,     -- everything the render used
  template_version VARCHAR(50)   NULL,

  docx_file_name   VARCHAR(255)  NULL,
  docx_mime_type   VARCHAR(100)  NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docx_size_bytes  INT           NULL,         -- as rendered, pre-compression
  docx_storage     VARCHAR(16)   NULL,         -- 'db' | 's3'
  docx_compression VARCHAR(16)   NULL DEFAULT 'deflate',
  docx_content     LONGBLOB      NULL,
  docx_uri         VARCHAR(1024) NULL,

  pdf_file_name    VARCHAR(255)  NULL,
  pdf_mime_type    VARCHAR(100)  NULL DEFAULT 'application/pdf',
  pdf_size_bytes   INT           NULL,
  pdf_storage      VARCHAR(16)   NULL,
  pdf_compression  VARCHAR(16)   NULL DEFAULT 'deflate',
  pdf_content      LONGBLOB      NULL,
  pdf_uri          VARCHAR(1024) NULL,

  generated_by     INT           NULL,         -- platform user
  generated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_current       TINYINT(1)    NOT NULL DEFAULT 1,

  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT           NULL,

  current_target   VARCHAR(80)   GENERATED ALWAYS AS (
                     IF(deleted_at IS NULL AND is_current = 1,
                        CONCAT(document_type, ':', IFNULL(role_id, 0), ':',
                               IFNULL(position_id, 0), ':', IFNULL(employee_id, 0)),
                        NULL)) VIRTUAL,

  UNIQUE KEY uq_hgdo_tenant  (company_id, id),
  UNIQUE KEY uq_hgdo_current (company_id, current_target),
  KEY idx_hgdo_role     (company_id, role_id, document_type, generated_at),
  KEY idx_hgdo_position (company_id, position_id),
  KEY idx_hgdo_employee (company_id, employee_id, document_type, generated_at),
  KEY idx_hgdo_type     (company_id, document_type, generated_at),

  CONSTRAINT fk_hgdo_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hgdo_role      FOREIGN KEY (company_id, role_id)     REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hgdo_position  FOREIGN KEY (company_id, position_id) REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hgdo_employee  FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hgdo_generator FOREIGN KEY (generated_by) REFERENCES users(id),
  CONSTRAINT fk_hgdo_creator   FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 9b. Open points ------------------------------------------------------
-- The unresolved organisation-design questions the current tool already carries
-- (Org_Chart_V12 has 15 of them). They are preserved rather than dropped at
-- import, because "who does this person actually report to?" is real information
-- about the organisation and losing it at migration is how the same question
-- gets asked again next year.
--
-- POLYMORPHIC ON PURPOSE, AND THEREFORE WITHOUT AN FK. entity_type +
-- entity_id can point at a role, a position, a work assignment or a work
-- context, and no single foreign key can express that. entity_id IS NULL for an
-- organisation-wide point. orgChartService.js validates the pair on write —
-- including that the target belongs to the same company, which is the check the
-- missing FK would otherwise have given for free. Do not write this table from
-- anywhere else.

CREATE TABLE IF NOT EXISTS hrms_open_points (
  id          INT       AUTO_INCREMENT PRIMARY KEY,
  company_id  INT       NOT NULL,
  entity_type ENUM('ORGANIZATION','ROLE','POSITION','WORK_ASSIGNMENT','WORK_CONTEXT') NOT NULL DEFAULT 'ORGANIZATION',
  entity_id   INT       NULL,     -- NULL for organisation-wide; no FK (polymorphic)
  description TEXT      NOT NULL,
  status      ENUM('OPEN','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
  resolution  TEXT      NULL,
  resolved_by INT       NULL,     -- platform user
  resolved_at TIMESTAMP NULL,

  deleted_at  DATETIME  DEFAULT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by  INT       NULL,

  UNIQUE KEY uq_hopp_tenant (company_id, id),
  KEY idx_hopp_entity (company_id, entity_type, entity_id),
  KEY idx_hopp_status (company_id, status, created_at),

  CONSTRAINT fk_hopp_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hopp_resolver FOREIGN KEY (resolved_by) REFERENCES users(id),
  CONSTRAINT fk_hopp_creator  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 9c. Audit log --------------------------------------------------------
-- APPEND-ONLY. Rows are inserted and never updated or deleted. `updated_at` and
-- `deleted_at` exist only because the platform's query engine requires
-- deleted_at on the main table of a read and the resource shape is uniform —
-- NOTHING in this app should ever write either column here, and a row that has
-- one set is evidence of a bug, not a deletion.
--
-- TiDB HAS NO TRIGGERS. Every row in this table is written by the service that
-- made the change, in the same transaction. A write that bypasses a service is
-- therefore unaudited — that is the cost of the decision and the reason the
-- generic query API's write path is not used for anything with a rule behind it.
--
-- `entity_type` / `entity_id` are polymorphic (every HR table can appear here),
-- so there is no FK, deliberately. `actor_user_id` is the platform user; where
-- the actor is also an employee, the employee is in after_json.
-- `request_id` ties a burst of rows to one HTTP request — an import commit
-- writes thousands and they must be traceable as one act.

CREATE TABLE IF NOT EXISTS hrms_audit_log (
  id            INT          AUTO_INCREMENT PRIMARY KEY,
  company_id    INT          NOT NULL,
  actor_user_id INT          NULL,
  entity_type   VARCHAR(100) NOT NULL,     -- table or logical entity name
  entity_id     INT          NOT NULL,     -- polymorphic; no FK
  -- READ is here for one reason: a disclosure of statutory identifiers
  -- (Aadhaar, PAN, UAN, ESI). Nothing else logs a read — an audit log that
  -- records every page view buries the one event it exists to preserve. The
  -- spec's original enum had no READ, and people.js briefly recorded a PII
  -- disclosure as GENERATE; for a real workforce's government ID numbers the
  -- log has to say what actually happened, so the enum widened instead.
  action        ENUM('CREATE','UPDATE','DELETE','APPROVE','GENERATE','IMPORT','READ') NOT NULL,
  before_json   JSON         NULL,
  after_json    JSON         NULL,
  occurred_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id    VARCHAR(100) NULL,         -- trace id; one per HTTP request

  deleted_at    DATETIME     DEFAULT NULL, -- never written; see the note above
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT          NULL,

  UNIQUE KEY uq_haud_tenant (company_id, id),
  KEY idx_haud_entity  (company_id, entity_type, entity_id, occurred_at),
  KEY idx_haud_actor   (company_id, actor_user_id, occurred_at),
  KEY idx_haud_action  (company_id, action, occurred_at),
  KEY idx_haud_request (company_id, request_id),

  CONSTRAINT fk_haud_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_haud_actor   FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_haud_creator FOREIGN KEY (created_by)    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 9d. Import runs ------------------------------------------------------
-- NOT IN THE SPEC. Added by plan §5.9 because the Karni migration is a real
-- inversion — the source is POSITION-shaped and the target is ASSIGNMENT-shaped —
-- and an import that writes thousands of rows with no record of what it decided
-- is unreversible and untrustworthy.
--
-- The import runs in three visible phases and this row is the run:
--   parsed    — the file was read; `parsed_counts_json` says what was found
--               (nodes by kind, people, kras, kpis, quals, open points).
--   validated — the report was produced; `findings_json` holds it: duplicate
--               people merged, nodes re-parented past a machine, role titles
--               collapsed into one Role, `kras` entries that look like genuine
--               KRAs (flagged, imported as responsibilities), qualification and
--               KPI duplicates normalised, and anything dropped. NOTHING IS
--               WRITTEN to the HR tables until the user accepts this report.
--   committed — the rows were written; `id_map_json` maps every source key
--               (node id, person name) to the ids created, which is what makes
--               a bad import traceable and reversible.
--   discarded — the user rejected the report. The run is kept: what was rejected
--               and why is as useful as what was accepted.
--
-- `source_hash` is the SHA-256 of the uploaded file. Re-uploading the same chart
-- is the normal case (people iterate on it), and the hash is what lets the
-- screen say "you already committed this exact file on the 3rd" instead of
-- quietly doubling the organisation.
--
-- The three JSON columns are JSON and not tables on purpose: a findings report
-- is read whole, by one screen, once, and is never queried across runs. Three
-- child tables would buy nothing and would have to be kept in step with a parser
-- that will change shape with every source format added.

CREATE TABLE IF NOT EXISTS hrms_import_runs (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  source_kind        ENUM('ORG_CHART_HTML','EXCEL','OTHER') NOT NULL DEFAULT 'ORG_CHART_HTML',
  source_file_name   VARCHAR(255) NOT NULL,
  source_hash        CHAR(64)     NULL,      -- SHA-256 hex of the uploaded bytes
  source_size_bytes  INT          NULL,
  status             ENUM('PARSED','VALIDATED','COMMITTED','DISCARDED','FAILED') NOT NULL DEFAULT 'PARSED',

  parsed_counts_json JSON         NULL,      -- what the file contained
  findings_json      JSON         NULL,      -- the validation report, shown before commit
  id_map_json        JSON         NULL,      -- source key -> created ids (commit only)
  error_text         TEXT         NULL,      -- why it FAILED, in words

  parsed_at          TIMESTAMP    NULL,
  validated_at       TIMESTAMP    NULL,
  committed_at       TIMESTAMP    NULL,
  discarded_at       TIMESTAMP    NULL,
  committed_by       INT          NULL,      -- platform user who accepted the report
  notes              TEXT         NULL,

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  UNIQUE KEY uq_himp_tenant (company_id, id),
  KEY idx_himp_status (company_id, status, created_at),
  KEY idx_himp_hash   (company_id, source_hash),

  CONSTRAINT fk_himp_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_himp_committer FOREIGN KEY (committed_by) REFERENCES users(id),
  CONSTRAINT fk_himp_creator   FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- End of cf_hrms schema. 46 tables.
--
-- Deliberately NOT created here:
--   * The five derived views the spec §7 lists (v_active_work_assignments,
--     v_position_fill_status, v_employee_reporting, v_effective_role_content,
--     v_daily_manpower_gap). Every one of them is a date-parameterised question
--     ("active on WHICH day?") and a view cannot take a parameter. They are
--     implemented as resourceDef relations plus service queries instead, where
--     the date is an argument. A view would have hard-coded CURDATE() and been
--     wrong for every historical question this model exists to answer.
--   * Any CHECK constraint. TiDB v8.5.3 runs with tidb_enable_check_constraint
--     = 0, so a CHECK in production is documentation dressed as a guarantee.
--     Every rule that would have been one is named at its table together with
--     the service that enforces it.
-- ============================================================================


-- ############################################################################
-- ## 10. RETROFITS — guarded ALTERs, and they belong at the END              ##
-- ############################################################################
-- A guarded ALTER must come after the CREATE TABLE of the table it alters.
--
-- That sounds obvious. It was still got wrong: this statement originally sat in
-- section 6f, next to the other guarded ALTER, ~500 lines BEFORE
-- hrms_audit_log is created in section 9. Every local run passed, because the
-- table already existed from an earlier run. The first FRESH database it ever
-- met was production, where it aborted the whole file at 35 of 46 tables.
--
-- So: two guards, not one. The ALTER runs only when the table EXISTS and its
-- enum lacks READ — which is true only for a database created before READ was
-- added. A fresh install creates the column with READ already in it (§9) and
-- skips this entirely.
--
-- Put any future retrofit here, not beside the table it touches.

SET @needs_read = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_audit_log'
     AND COLUMN_NAME  = 'action'
     AND COLUMN_TYPE NOT LIKE '%READ%');
SET @sql = IF(@needs_read = 1,
  'ALTER TABLE hrms_audit_log MODIFY COLUMN action ENUM(''CREATE'',''UPDATE'',''DELETE'',''APPROVE'',''GENERATE'',''IMPORT'',''READ'') NOT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
