-- ============================================================================
-- cf_hrms — People + Organisation Definition. Full schema, 51 tables.
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
-- THE ONE TREE (2026-10-10). Everything the organisation is made of is a
-- department or a sub-department: Production, the Printing process under it,
-- the Pelican machine under that, and the crew two areas share. A machine used
-- to be a separate thing (hrms_work_contexts, §1c) and the two ideas overlapped
-- until nobody could say which one a seat belonged to. Now a position has
-- exactly one department_id and that is the whole answer.
--
-- `department_type` is a LABEL the company chooses — "Department", "Process",
-- "Machine / area", "Shared crew". It is free text on purpose and NO LOGIC MAY
-- BRANCH ON IT: another client will call the same level a "Line" or a "Cell".
-- What the code may branch on is the tree (parent_department_id) and is_shared.
--
-- `is_shared` marks a department that exists to serve OTHER departments — one
-- crew working two areas. Which ones is hrms_department_serves (§1b-2). It is
-- drawn as one box pointing at each of them, never cloned per machine.
--
-- SERVICE RULES (no CHECK in TiDB), all in organisationService.js:
--   * a department may not be its own ancestor (the walk up parent_department_id);
--   * is_shared is 0 or 1;
--   * only a shared department may have serves rows, and clearing is_shared
--     retires them.

CREATE TABLE IF NOT EXISTS hrms_departments (
  id                   INT          AUTO_INCREMENT PRIMARY KEY,
  company_id           INT          NOT NULL,
  code                 VARCHAR(50)  NULL,
  name                 VARCHAR(200) NOT NULL,
  parent_department_id INT          NULL,
  department_type      VARCHAR(40)  NULL,                    -- a label only; also a guarded ALTER in §10c
  is_shared            TINYINT(1)   NOT NULL DEFAULT 0,      -- serves other departments; also a guarded ALTER in §10c
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


-- ----- 1b-2. Which departments a shared department serves --------------------
-- One row per (shared department, department it serves). "Shared · Packing
-- Machine 1 & 2 + Loading" has two rows. The shared department still has ONE
-- parent in the tree (the nearest unit that encloses everything it serves);
-- these rows are the extra lines the chart draws from its box.
--
-- Soft-delete-aware uniqueness the way the rest of the file does it: the
-- generated column is NULL once the row is retired, so a pair can be removed
-- and added again without tripping the key.
--
-- SERVICE RULES (no CHECK in TiDB), organisationService.js:
--   * department_id must be a live department with is_shared = 1;
--   * a department does not serve itself;
--   * serves_department_id must be a live department of the same company (the
--     composite FK holds the company half).

CREATE TABLE IF NOT EXISTS hrms_department_serves (
  id                   INT        AUTO_INCREMENT PRIMARY KEY,
  company_id           INT        NOT NULL,
  department_id        INT        NOT NULL,
  serves_department_id INT        NOT NULL,
  notes                TEXT       NULL,

  deleted_at           DATETIME   DEFAULT NULL,
  created_at           TIMESTAMP  DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT        NULL,

  serves_active        INT        GENERATED ALWAYS AS (IF(deleted_at IS NULL, serves_department_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hdsv_tenant (company_id, id),
  UNIQUE KEY uq_hdsv_pair   (company_id, department_id, serves_active),
  KEY idx_hdsv_department (company_id, department_id),
  KEY idx_hdsv_serves     (company_id, serves_department_id),

  CONSTRAINT fk_hdsv_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hdsv_department FOREIGN KEY (company_id, department_id)        REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hdsv_serves     FOREIGN KEY (company_id, serves_department_id) REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hdsv_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1c. Work contexts — THE REASON MACHINES ARE NOT MANAGERS -------------
-- RETIRED FROM THE MODEL'S SURFACE, 2026-10-10 — NOT DROPPED. A machine, an
-- area and a shared crew are DEPARTMENTS now (§1b), and a seat's one
-- department_id says where it works. The org-chart import no longer writes
-- this table or hrms_position_work_contexts, and the chart and department
-- read models no longer read them. The tables, their link tables and the
-- scope_work_context_id / work_context_id columns elsewhere all stay: this
-- file never drops, the admin screens still work on them, and a reporting
-- scope may still name one. What follows is the original reasoning, and the
-- rule it protects — a machine is never a manager — is unchanged.
--
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


-- ----- 1d-2. Holiday calendars — BEFORE shifts and holidays, which point at it --
-- Added 2026-10-11 (CF_HRMS_HIRING_SPEC.md §6). A holiday calendar is a named
-- list of dated holidays (hrms_holidays.calendar_id, §1f). A shift selects one
-- (hrms_shifts.holiday_calendar_id, §1e); several shifts may share one. A new
-- calendar starts empty — nothing here invents a list of holidays.
--
-- It sits here, above both tables that reference it, because this file builds by
-- ORDER. An existing database gets the two referencing columns from section 10d.

CREATE TABLE IF NOT EXISTS hrms_holiday_calendars (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  name         VARCHAR(150) NOT NULL,
  description  VARCHAR(500) NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | INACTIVE

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  name_active  VARCHAR(150) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hhcl_tenant (company_id, id),
  UNIQUE KEY uq_hhcl_name   (company_id, name_active),

  CONSTRAINT fk_hhcl_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hhcl_creator FOREIGN KEY (created_by) REFERENCES users(id)
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
--
-- SINCE 2026-10-11 A SHIFT'S HOURS ARE PER DAY OF THE WEEK (hrms_shift_days,
-- §1e-2, seven rows per shift). The three columns above stay and MIRROR the
-- first working day that has hours, so everything written before keeps reading
-- a shift the way it did. `week_summary` is the same idea for the one line a
-- position shows under its shift ("Mon–Sat 08:00–20:00"): organisationService
-- writes it whenever it writes the days, so no read needs the day rows for it.
-- `holiday_calendar_id` is the calendar the shift observes; NULL = no holidays.

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
  holiday_calendar_id INT         NULL,              -- the calendar this shift observes; NULL = no holidays
  week_summary       VARCHAR(200) NULL,              -- "Mon–Sat 08:00–20:00", kept in step with hrms_shift_days

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  code_active        VARCHAR(50)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hshf_tenant (company_id, id),
  UNIQUE KEY uq_hshf_code   (company_id, code_active),
  KEY idx_hshf_status (company_id, status),
  KEY idx_hshf_calendar (company_id, holiday_calendar_id),

  CONSTRAINT fk_hshf_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hshf_calendar FOREIGN KEY (company_id, holiday_calendar_id) REFERENCES hrms_holiday_calendars(company_id, id),
  CONSTRAINT fk_hshf_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 1e-2. Shift days — a shift's hours, per day of the week ---------------
-- Added 2026-10-11 (spec §6). SEVEN ROWS PER SHIFT, ALWAYS: weekday 1 = Monday
-- … 7 = Sunday. A day is working or not; a working day has a start, an end and
-- a break, or — the flexible shift — none of them.
--
-- `crosses_midnight` is derived on write (the end is at or before the start:
-- 20:00–08:00) and stored for the same reason it is on hrms_shifts.
--
-- A row is updated in place — there is one per weekday for good — so the unique
-- key is plainly on (shift, weekday). The rule that there are seven, that a
-- working day has both times or neither, and that a break is shorter than the
-- day lives in organisationService.js; services/shiftRead.js fills a weekday
-- that has no row when it reads, so a shift is never shown with fewer than seven.

CREATE TABLE IF NOT EXISTS hrms_shift_days (
  id               INT         AUTO_INCREMENT PRIMARY KEY,
  company_id       INT         NOT NULL,
  shift_id         INT         NOT NULL,
  weekday          TINYINT     NOT NULL,              -- 1 = Monday … 7 = Sunday
  is_working       TINYINT(1)  NOT NULL DEFAULT 1,
  start_time       TIME        NULL,                  -- NULL on a working day = no fixed hours
  end_time         TIME        NULL,
  crosses_midnight TINYINT(1)  NOT NULL DEFAULT 0,
  break_minutes    INT         NOT NULL DEFAULT 0,

  deleted_at       DATETIME    DEFAULT NULL,
  created_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT         NULL,

  UNIQUE KEY uq_hshd_tenant (company_id, id),
  UNIQUE KEY uq_hshd_day    (company_id, shift_id, weekday),

  CONSTRAINT fk_hshd_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hshd_shift   FOREIGN KEY (company_id, shift_id) REFERENCES hrms_shifts(company_id, id),
  CONSTRAINT fk_hshd_creator FOREIGN KEY (created_by) REFERENCES users(id)
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
--
-- SINCE 2026-10-11 A HOLIDAY BELONGS TO A CALENDAR (`calendar_id`, §1d-2), and
-- the uniqueness is per calendar: 15 August may be in two calendars, and once
-- in each. The key is uq_hhol_calday; the old one (uq_hhol_day, a date once per
-- company) is retired by section 10d on a database that still has it.

CREATE TABLE IF NOT EXISTS hrms_holidays (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  location_id  INT          NULL,                   -- NULL = whole company
  holiday_date DATE         NOT NULL,
  name         VARCHAR(200) NOT NULL,
  is_optional  TINYINT(1)   NOT NULL DEFAULT 0,
  calendar_id  INT          NULL,                   -- the calendar it is in

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  location_key INT          GENERATED ALWAYS AS (IFNULL(location_id, 0)) VIRTUAL,
  date_active  DATE         GENERATED ALWAYS AS (IF(deleted_at IS NULL, holiday_date, NULL)) VIRTUAL,

  UNIQUE KEY uq_hhol_tenant (company_id, id),
  UNIQUE KEY uq_hhol_calday (company_id, calendar_id, location_key, date_active),
  KEY idx_hhol_date (company_id, holiday_date),

  CONSTRAINT fk_hhol_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hhol_calendar FOREIGN KEY (company_id, calendar_id) REFERENCES hrms_holiday_calendars(company_id, id),
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
  measurement_type  ENUM('NUMBER','PERCENTAGE','CURRENCY','DURATION','BOOLEAN','RATING','TEXT','WEIGHT','LENGTH','DATE') NOT NULL DEFAULT 'NUMBER',
                                                   -- "measured in" (§25); TEXT / RATING = not set
  unit              VARCHAR(50)  NULL,             -- %, minutes, kg
  direction         ENUM('HIGHER_BETTER','LOWER_BETTER','TARGET_RANGE','NEUTRAL','EXACT') NULL,   -- "which way is better"; NEUTRAL / NULL = not set
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
  target_json            JSON          NULL,   -- the structured target (§25): { measure, unit, direction, value | min+max | date }
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
-- Vacancy is DERIVED, never stored: a position is vacant when no live work
-- assignment points at it (services/seatCount.js). Storing a filled flag would
-- be a second source of truth that drifts the first time someone ends an
-- assignment without touching the position.


-- ----- 4a. Positions --------------------------------------------------------
-- `role_id` is REQUIRED — a slot with no kind of work in it is not a position.
-- `position_title` overrides the role's title for display only ("Printing
-- Operator - Pelican"); the JD still resolves content from the role.
--
-- ONE POSITION IS ONE CHAIR (2026-10-10): one person, one shift. Six helpers
-- are six positions, drawn as one card (services/positionCards.js).
--
-- `sanctioned_headcount` is ALWAYS 1. The column stays (no DDL was needed for
-- the change — the spec's own note said "the value simply stays 1") but nothing
-- reads it for a count: positionService stores 1 whatever a caller sends, and
-- services/seatCount.js is the one definition of seats, filled and vacant. It
-- used to hold a GROUPED position's headcount ("Helper" x 6); do not bring
-- that back by reading it.
--
-- `default_shift_id` is THE POSITION'S SHIFT, not a default: the chair is on
-- that shift and so is whoever sits in it (changing it moves the occupant's
-- assignment too). Set on every position the app creates — the company's
-- General shift when none is named. NULL only in a company with no shifts.
-- It is also why hrms_shifts is created in section 1.
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
  -- A form of address ('Mr.', 'Ms.'), stored exactly as the source wrote it and
  -- SEPARATE from the name on purpose. It is not part of a name: full_name is
  -- what the org-chart import's duplicate-person check keys on, what the people
  -- list indexes and sorts by, and what a letter template prefixes with a
  -- salutation of its own — a prefix glued into the name cannot be taken out
  -- again without guessing where the name starts. It is also NOT `gender`:
  -- reading 'Ms.' as female is an inference, and this column records what was
  -- written, not what it implies.
  salutation              VARCHAR(10)  NULL,
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
--   SANCTIONED headcount — the number of live, non-CLOSED hrms_positions (one
--     position is one seat; the sanctioned_headcount column is always 1).
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
-- NO LONGER DECIDES SEATS (2026-10-10). The retired org-chart import wrote two
-- position-level rows here for a DN (day+night) position, and the seat count
-- was read from them. A position is one chair on one shift now, day and night
-- are two positions, and `scripts/one-chair-positions.mjs` retired those rows:
-- a chair IS the requirement. Nothing in services/ reads this table for a seat
-- count, a vacancy or a shift pattern. It remains for what the header above
-- says it is for — what operations needs on a shift, when that differs from
-- the sanctioned positions.

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
-- `annual_entitlement` IS NO LONGER READ (2026-10-11). It was the simple V1
-- accrual — a number per period — before leave policies existed. How much of a
-- leave type somebody gets, how it is earned, what carries forward and what is
-- paid out now live in the POLICY RULE (section 13, hrms_leave_policy_rules).
-- The column stays, because this file has no DROPs; nothing writes or reads it.

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
  note            VARCHAR(500)  NULL,         -- why HR entered this opening (spec §22; also §23)

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
  -- spec §22 (2026-10-16; also §23, for the databases that already exist):
  half_day             ENUM('FIRST','SECOND') NULL,   -- one date only, first or second half
  days_json            JSON          NULL,                 -- the counted days, as decided at submit
  decision_note        TEXT          NULL,
  decided_by           INT           NULL,                 -- the login that approved or rejected
  decided_at           DATETIME      NULL,
  cancel_note          TEXT          NULL,
  raised_by_hr         TINYINT(1)    NOT NULL DEFAULT 0,

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
  CONSTRAINT fk_hlvr_creator  FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_hlvr_decider  FOREIGN KEY (decided_by) REFERENCES users(id)
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
-- End of cf_hrms schema as first built: 47 tables. Section 11 (hiring), below the
-- retrofits, adds four more: 51.
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


-- ----- 10b. hrms_employees.salutation ---------------------------------------
-- Added 2026-10-08 for the Org_Chart_V28 import, which carries a `ttl` ('Mr.',
-- 'Ms.') on 68 of its 71 named people.
--
-- DECLARED IN TWO PLACES, AND IT HAS TO BE BOTH. §5a creates the column, so a
-- database built from this file has it. This ALTER gives it to the databases
-- that already exist, local and production, which §5a can never reach because
-- CREATE TABLE IF NOT EXISTS is a no-op on a table that is already there.
-- Neither half alone is enough, and the half that gets forgotten is usually
-- this one: core-init.sql had `users.preferences` live in every running database
-- and declared in no migration, so GET /user/profile answered 500 on any
-- freshly built one.
--
-- And it sits HERE, at the end, below the CREATE it alters — the rule the
-- comment above this section was written for.

SET @needs_salutation = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_employees'
     AND COLUMN_NAME  = 'salutation');
SET @sql = IF(@needs_salutation = 1,
  'ALTER TABLE hrms_employees ADD COLUMN salutation VARCHAR(10) NULL AFTER full_name',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ----- 10c. hrms_departments.department_type / is_shared ---------------------
-- Added 2026-10-10 when machines and shared crews became departments (§1b).
-- Declared in the CREATE in §1b AND here, for the same reason as §10b: the
-- CREATE reaches a new database, this reaches the ones that already exist.
--
-- One column per ALTER. TiDB has refused a multi-clause ALTER that MySQL takes
-- (ADD COLUMN + ADD KEY on the new column, cf_erp 2026-10-09), so nothing here
-- relies on two changes landing in one statement.
--
-- hrms_department_serves needs no retrofit: it is a new table, and
-- CREATE TABLE IF NOT EXISTS in §1b-2 reaches old and new databases alike.

SET @needs_department_type = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_departments'
     AND COLUMN_NAME  = 'department_type');
SET @sql = IF(@needs_department_type = 1,
  'ALTER TABLE hrms_departments ADD COLUMN department_type VARCHAR(40) NULL AFTER parent_department_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @needs_is_shared = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_departments'
     AND COLUMN_NAME  = 'is_shared');
SET @sql = IF(@needs_is_shared = 1,
  'ALTER TABLE hrms_departments ADD COLUMN is_shared TINYINT(1) NOT NULL DEFAULT 0 AFTER department_type',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 11. HIRING — filling a vacant position (TM/CF_HRMS_HIRING_SPEC.md §2)    ##
-- ############################################################################
-- Added 2026-10-10. A HIRING is the work of filling ONE vacant position:
--
--   JD  ->  OFFER  ->  APPOINTMENT  ->  DONE
--                \->  CLOSED (DECLINED | LAPSED | CANCELLED), from any stage before DONE
--
-- THE CANDIDATE IS A DRAFT UNTIL DONE. Their name, phone, address and offered
-- pay live on the hiring row and nowhere else: no hrms_employees row, no
-- employee code, not in any headcount. Appointing is ONE transaction in
-- services/hiringService.js that issues the code, creates the employee, puts
-- them in the position and stores the appointment letter — or does none of it.
--
-- All four tables are new, so CREATE TABLE IF NOT EXISTS reaches old and new
-- databases alike and nothing here needs a retrofit in section 10. They sit
-- after every table they reference (positions, employees, work assignments,
-- generated documents), which is why this section is at the end of the file.
--
-- stage / close_reason / kind are VARCHAR, not ENUM: TiDB does not enforce an
-- ENUM the way MySQL does (it has stored '' in one), and a new stage must not be
-- an ALTER on a live table. hiringService.js validates every value it writes.


-- ----- 11a. Hirings -----------------------------------------------------------
-- ONE OPEN HIRING PER POSITION is a database guarantee, not a service promise:
-- `open_position` is the position id while the hiring is open (not DONE, not
-- CLOSED, not deleted) and NULL otherwise, and MySQL never compares NULLs in a
-- unique index — so any number of finished hirings can point at a position and
-- at most one live one.
--
-- `ref_no` is the letter reference (KPPL/HR/26-27/003), issued by the code
-- generator with the FIRST offer letter and printed on the appointment letter
-- too. It is kept when a hiring is closed: a number that went out on a letter is
-- never handed to somebody else.
--
-- The terms (designation, department_name, reporting_to_*, place_of_posting,
-- probation and notice) are TEXT AS IT WILL PRINT, filled from the position and
-- the company's hiring settings when the hiring starts and editable until the
-- offer is accepted. They are deliberately not foreign keys: a letter says what
-- was offered, and must keep saying it after the department is renamed.
--
-- `candidate_address` is the address as it prints, line breaks kept.
--
-- jd_document_id / employee_id / assignment_id are what each stage produced:
-- the frozen job description (a ROLE_JD row of hrms_generated_documents for
-- this position), and at DONE the employee and the work assignment.

CREATE TABLE IF NOT EXISTS hrms_hirings (
  id                      INT           AUTO_INCREMENT PRIMARY KEY,
  company_id              INT           NOT NULL,
  position_id             INT           NOT NULL,
  stage                   VARCHAR(20)   NOT NULL DEFAULT 'JD',   -- JD | OFFER | APPOINTMENT | DONE | CLOSED
  close_reason            VARCHAR(20)   NULL,                    -- DECLINED | LAPSED | CANCELLED
  close_note              VARCHAR(500)  NULL,
  ref_no                  VARCHAR(100)  NULL,

  candidate_salutation    VARCHAR(10)   NULL,
  candidate_name          VARCHAR(200)  NULL,
  candidate_phone         VARCHAR(40)   NULL,
  candidate_email         VARCHAR(200)  NULL,
  candidate_address       TEXT          NULL,
  candidate_gender        VARCHAR(40)   NULL,
  candidate_date_of_birth DATE          NULL,

  designation             VARCHAR(200)  NULL,
  department_name         VARCHAR(200)  NULL,
  reporting_to_title      VARCHAR(200)  NULL,
  reporting_to_name       VARCHAR(200)  NULL,
  place_of_posting        VARCHAR(300)  NULL,
  proposed_joining_date   DATE          NULL,
  offer_date              DATE          NULL,
  offer_valid_until       DATE          NULL,
  annual_ctc              DECIMAL(14,2) NULL,
  probation_months        INT           NOT NULL DEFAULT 3,
  notice_days_probation   INT           NOT NULL DEFAULT 15,
  notice_days_confirmed   INT           NOT NULL DEFAULT 30,
  signatory_name          VARCHAR(200)  NULL,
  signatory_designation   VARCHAR(200)  NULL,

  offer_accepted_on       DATE          NULL,
  joining_date            DATE          NULL,
  appointment_date        DATE          NULL,

  jd_document_id          INT           NULL,
  employee_id             INT           NULL,
  assignment_id           INT           NULL,

  deleted_at              DATETIME      DEFAULT NULL,
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by              INT           NULL,

  open_position           INT           GENERATED ALWAYS AS (
                            IF(deleted_at IS NULL AND stage NOT IN ('DONE', 'CLOSED'), position_id, NULL)) VIRTUAL,
  ref_active              VARCHAR(100)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(ref_no), NULL)) VIRTUAL,

  UNIQUE KEY uq_hhir_tenant (company_id, id),
  UNIQUE KEY uq_hhir_open   (company_id, open_position),
  UNIQUE KEY uq_hhir_ref    (company_id, ref_active),
  KEY idx_hhir_position (company_id, position_id),
  KEY idx_hhir_stage    (company_id, stage, updated_at),
  KEY idx_hhir_employee (company_id, employee_id),

  CONSTRAINT fk_hhir_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hhir_position   FOREIGN KEY (company_id, position_id)    REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hhir_jd         FOREIGN KEY (company_id, jd_document_id) REFERENCES hrms_generated_documents(company_id, id),
  CONSTRAINT fk_hhir_employee   FOREIGN KEY (company_id, employee_id)    REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hhir_assignment FOREIGN KEY (company_id, assignment_id)  REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_hhir_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 11b. Hiring letters ----------------------------------------------------
-- The offer letter and the appointment letter, every version of each. A letter
-- that was generated is kept even after it is generated again — the one that
-- went to the candidate may be version 1 — and `is_current` marks the latest.
-- `current_key` makes "one current letter per hiring per kind" a database
-- guarantee, the same way hrms_generated_documents.current_target does.
--
-- BYTES IN THE ROW, like every other file in this app (no persistent disk on
-- Render's free plan): DEFLATE-compressed through services/documentStorage.js,
-- which refuses anything near TiDB's ~6 MB row limit before the INSERT.
-- `size_bytes` is the size as rendered, before compression.
--
-- `snapshot_json` is the values the letter printed, so "what did we offer" has
-- an answer without opening the file. It holds a salary and an address: this
-- table is deliberately NOT in resourceDef.json, so the generic query API cannot
-- read it, and the routes that do are gated on cf_hrms_people_view.

CREATE TABLE IF NOT EXISTS hrms_hiring_letters (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  hiring_id     INT           NOT NULL,
  kind          VARCHAR(20)   NOT NULL,                -- OFFER | APPOINTMENT
  version       INT           NOT NULL DEFAULT 1,
  is_current    TINYINT(1)    NOT NULL DEFAULT 1,
  file_name     VARCHAR(255)  NOT NULL,
  mime_type     VARCHAR(100)  NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size_bytes    INT           NULL,                    -- as rendered, pre-compression
  storage       VARCHAR(16)   NULL,                    -- 'db' | 's3'
  compression   VARCHAR(16)   NULL,                    -- 'deflate' | NULL
  content       LONGBLOB      NULL,
  snapshot_json JSON          NULL,                    -- the values printed
  generated_by  INT           NULL,                    -- platform user
  generated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  current_key   VARCHAR(60)   GENERATED ALWAYS AS (
                  IF(deleted_at IS NULL AND is_current = 1, CONCAT(hiring_id, ':', kind), NULL)) VIRTUAL,

  UNIQUE KEY uq_hhlt_tenant  (company_id, id),
  UNIQUE KEY uq_hhlt_current (company_id, current_key),
  KEY idx_hhlt_hiring (company_id, hiring_id, kind, version),

  CONSTRAINT fk_hhlt_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hhlt_hiring    FOREIGN KEY (company_id, hiring_id) REFERENCES hrms_hirings(company_id, id),
  CONSTRAINT fk_hhlt_generator FOREIGN KEY (generated_by) REFERENCES users(id),
  CONSTRAINT fk_hhlt_creator   FOREIGN KEY (created_by)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 11c. Letter templates --------------------------------------------------
-- A company's own offer and appointment letter: a .docx whose text carries
-- placeholders in braces ({candidate_name}, {annual_ctc} ...), filled by
-- services/letterRenderer.js. A company with no row here gets the built-in
-- letter. An upload replaces the current one and the old row is kept
-- (`is_current` 0), so a letter can be traced to the template that made it.
-- Same byte storage as 11b.

CREATE TABLE IF NOT EXISTS hrms_letter_templates (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  kind         VARCHAR(20)   NOT NULL,                 -- OFFER | APPOINTMENT
  file_name    VARCHAR(255)  NOT NULL,
  size_bytes   INT           NULL,                     -- as uploaded, pre-compression
  storage      VARCHAR(16)   NULL,                     -- 'db' | 's3'
  compression  VARCHAR(16)   NULL,                     -- 'deflate' | NULL
  content      LONGBLOB      NULL,
  uploaded_by  INT           NULL,                     -- platform user
  uploaded_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_current   TINYINT(1)    NOT NULL DEFAULT 1,

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  current_kind VARCHAR(20)   GENERATED ALWAYS AS (IF(deleted_at IS NULL AND is_current = 1, kind, NULL)) VIRTUAL,

  UNIQUE KEY uq_hltp_tenant  (company_id, id),
  UNIQUE KEY uq_hltp_current (company_id, current_kind),

  CONSTRAINT fk_hltp_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hltp_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id),
  CONSTRAINT fk_hltp_creator  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 11d. Hiring settings ---------------------------------------------------
-- ONE ROW PER COMPANY: what a letter prints that is the company's and not the
-- candidate's, and the terms a new hiring starts with. A company with no row
-- reads as the defaults below with its own name — the row is written the first
-- time somebody saves the settings.
--
-- Never soft-deleted: the unique key is plainly on company_id. `deleted_at` is
-- here only because every table carries it.

CREATE TABLE IF NOT EXISTS hrms_hiring_settings (
  id                    INT           AUTO_INCREMENT PRIMARY KEY,
  company_id            INT           NOT NULL,
  company_legal_name    VARCHAR(200)  NULL,
  signatory_name        VARCHAR(200)  NULL,
  signatory_designation VARCHAR(200)  NULL,
  place_of_posting      VARCHAR(300)  NULL,
  jurisdiction          VARCHAR(200)  NULL,
  probation_months      INT           NOT NULL DEFAULT 3,
  notice_days_probation INT           NOT NULL DEFAULT 15,
  notice_days_confirmed INT           NOT NULL DEFAULT 30,
  offer_valid_days      INT           NOT NULL DEFAULT 7,

  deleted_at            DATETIME      DEFAULT NULL,
  created_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by            INT           NULL,

  UNIQUE KEY uq_hhst_tenant  (company_id, id),
  UNIQUE KEY uq_hhst_company (company_id),

  CONSTRAINT fk_hhst_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hhst_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 12. LEAVING — notice and closing an employee (CF_HRMS_HIRING_SPEC.md §4) ##
-- ############################################################################
-- Added 2026-10-11. AN EMPLOYEE IS NEVER DELETED. Leaving is
--
--   ACTIVE  ->  NOTICE  ->  EXITED        (hrms_employees.employment_status)
--                  \->  ACTIVE again, when the notice is withdrawn
--
-- and this table is the record of each time it happened: who decided
-- (RESIGNED = the employee, REMOVED = the company), why, the day notice was
-- given and the last working day.
--
--   OPEN       the person is on notice. They stay in their position and in
--              every count until the record is closed.
--   WITHDRAWN  the resignation or removal was taken back. Kept, not deleted:
--              that somebody resigned in March and stayed is part of the file.
--   CLOSED     the person has left. services/exitService.js closes in ONE
--              transaction: employee EXITED with exit_date = last working day,
--              every open work assignment ended on that day, an EXIT employment
--              event, and the linked login's access to the company's apps
--              removed.
--
-- ONE OPEN RECORD PER EMPLOYEE is a database guarantee: `open_employee` is the
-- employee id while the record is OPEN and NULL otherwise, and MySQL never
-- compares NULLs in a unique index. The same column is what the org chart joins
-- on to mark a person "on notice" without a query of its own.
--
-- exit_type / reason_code / status are VARCHAR, not ENUM (TiDB does not enforce
-- one). The reasons are a list in code — exitRead.js — validated on write.
--
-- A new table, so CREATE TABLE IF NOT EXISTS reaches old and new databases
-- alike and nothing here needs a retrofit in section 10.

CREATE TABLE IF NOT EXISTS hrms_employee_exits (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  employee_id      INT           NOT NULL,
  exit_type        VARCHAR(20)   NOT NULL,                 -- RESIGNED | REMOVED
  reason_code      VARCHAR(30)   NOT NULL,
  note             VARCHAR(1000) NULL,
  notice_date      DATE          NOT NULL,
  last_working_day DATE          NOT NULL,
  status           VARCHAR(20)   NOT NULL DEFAULT 'OPEN',  -- OPEN | WITHDRAWN | CLOSED
  closed_on        DATE          NULL,                     -- the day the record was closed
  withdrawn_on     DATE          NULL,
  withdraw_note    VARCHAR(1000) NULL,
  close_note       VARCHAR(1000) NULL,

  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT           NULL,
  closed_by        INT           NULL,

  open_employee    INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL AND status = 'OPEN', employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hexi_tenant (company_id, id),
  UNIQUE KEY uq_hexi_open   (company_id, open_employee),
  KEY idx_hexi_employee (company_id, employee_id, status),
  KEY idx_hexi_status   (company_id, status, last_working_day),

  CONSTRAINT fk_hexi_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hexi_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hexi_creator  FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_hexi_closer   FOREIGN KEY (closed_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 10d. RETROFITS for shifts by weekday and holiday calendars (2026-10-11)  ##
-- ############################################################################
-- At the END of the file, like every retrofit (see section 10): each statement
-- below alters a table created far above it, and a guarded ALTER above its
-- CREATE is what once stopped this file at 35 of 46 tables.
--
-- Declared in the CREATEs (§1e, §1f) AND here, for the reason §10b gives: the
-- CREATE reaches a new database, this reaches the ones that already exist. On a
-- database built from this file every guard below is false and nothing runs.
--
-- One change per ALTER (TiDB has refused a multi-clause one). The one DROP is of
-- an INDEX, guarded, after its replacement exists: uq_hhol_day allowed a date
-- once per company, and a date must now be allowed once per CALENDAR. No data is
-- touched by it.
--
-- NOT HERE: the rows. Seven day rows for every existing shift, their summary
-- line, and a "Company holidays" calendar for holidays that have none are
-- written by scripts/apply-shift-calendar-schema.mjs (existing databases) and by
-- seed.sql (the shifts it seeds). This file is the schema.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_shifts' AND COLUMN_NAME = 'holiday_calendar_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_shifts ADD COLUMN holiday_calendar_id INT NULL AFTER status', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_shifts' AND COLUMN_NAME = 'week_summary');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_shifts ADD COLUMN week_summary VARCHAR(200) NULL AFTER holiday_calendar_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_shifts' AND INDEX_NAME = 'idx_hshf_calendar');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_shifts ADD KEY idx_hshf_calendar (company_id, holiday_calendar_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_shifts' AND CONSTRAINT_NAME = 'fk_hshf_calendar');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_shifts ADD CONSTRAINT fk_hshf_calendar FOREIGN KEY (company_id, holiday_calendar_id) REFERENCES hrms_holiday_calendars(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_holidays' AND COLUMN_NAME = 'calendar_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_holidays ADD COLUMN calendar_id INT NULL AFTER is_optional', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_holidays' AND INDEX_NAME = 'uq_hhol_calday');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_holidays ADD UNIQUE KEY uq_hhol_calday (company_id, calendar_id, location_key, date_active)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_holidays' AND CONSTRAINT_NAME = 'fk_hhol_calendar');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_holidays ADD CONSTRAINT fk_hhol_calendar FOREIGN KEY (company_id, calendar_id) REFERENCES hrms_holiday_calendars(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_holidays' AND INDEX_NAME = 'uq_hhol_day');
SET @sql = IF(@c > 0, 'ALTER TABLE hrms_holidays DROP INDEX uq_hhol_day', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 13. LEAVE POLICIES (CF_HRMS_HIRING_SPEC.md §8, 2026-10-11)               ##
-- ############################################################################
-- A LEAVE TYPE is a company-wide name (hrms_leave_types, §8a). How much of it
-- somebody gets, how it is earned and what happens to what is left over is a
-- LEAVE POLICY: a named, standalone set of rules, one rule per leave type it
-- grants. A policy belongs to no role and no location by itself — it is
-- ASSIGNED, at three levels, and the most specific wins:
--
--     company default  ->  location  ->  role
--
-- A position's policy is its role's assignment, else its location's, else the
-- company default, else none. That resolution has ONE implementation
-- (services/leavePolicyRead.js); nothing else re-derives it.
--
-- hrms_leave_types.annual_entitlement (§8a) IS NO LONGER READ: the quantity of
-- a leave type lives in the policy rule now. The column stays — no DROPs in
-- this file — and nothing writes or reads it.
--
-- This round defines policies and where they apply. Balances, accrual runs,
-- applying for leave and approvals are not built on them yet (§8b, §8c are the
-- older tables for those and are untouched).
--
-- All three tables are new: CREATE TABLE IF NOT EXISTS reaches old and new
-- databases alike. basis / accrual / carry_forward / applies_to / status / scope
-- are VARCHAR, validated by services/leavePolicyService.js.


-- ----- 13a. Leave policies ---------------------------------------------------
-- status DRAFT | ACTIVE | ARCHIVED. Only an ACTIVE policy can be assigned, and
-- an assigned policy cannot be archived or put back to draft (the service says
-- where it is used) — so every assignment always points at an ACTIVE policy.
-- year_starts_month: 1 = January to December, 4 = April to March.

CREATE TABLE IF NOT EXISTS hrms_leave_policies (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  code              VARCHAR(50)   NULL,
  name              VARCHAR(150)  NOT NULL,
  description       VARCHAR(1000) NULL,
  year_starts_month TINYINT       NOT NULL DEFAULT 1,
  effective_from    DATE          NULL,                 -- §24: nothing is earned before it
  status            VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  code_active       VARCHAR(50)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(code), NULL)) VIRTUAL,
  name_active       VARCHAR(150)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hlpo_tenant (company_id, id),
  UNIQUE KEY uq_hlpo_code   (company_id, code_active),
  UNIQUE KEY uq_hlpo_name   (company_id, name_active),
  KEY idx_hlpo_status (company_id, status),

  CONSTRAINT fk_hlpo_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlpo_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 13b. Leave policy rules -----------------------------------------------
-- One rule per (policy, leave type). A policy's rules are saved as a SET: the
-- editor sends all of them and the service replaces the set in one transaction,
-- so a policy is never half-changed. That is why the unique key is plain and a
-- rule has no life of its own (its id changes on a save).
--
--   basis     PER_YEAR          `days` a year
--             PER_EVENT         `days` each time it happens (maternity, bereavement)
--             UNLIMITED_UNPAID  no quantity (leave without pay)
--   accrual   UPFRONT           all at the start of the year
--             MONTHLY           days / 12 each month
--             PER_DAYS_WORKED   one day for every `days_worked_per_leave_day` days worked
--             ON_REQUEST        granted when it happens
--             EARNED_BY_WORK    credited when a holiday or weekly off is worked (compensatory off)
--             HALF_YEARLY       days / 2 on the first day of the year and of its 7th month (§24)
--   carry_forward  NONE | CAPPED (`carry_forward_cap_days`) | ALL
--   applies_to     ANYONE | WOMEN | MEN
-- A column that does not apply to the rule's basis and accrual is stored NULL
-- (or 0): the service clears what a combination makes meaningless, so no reader
-- has to ask whether a stale number counts.

CREATE TABLE IF NOT EXISTS hrms_leave_policy_rules (
  id                        INT           AUTO_INCREMENT PRIMARY KEY,
  company_id                INT           NOT NULL,
  policy_id                 INT           NOT NULL,
  leave_type_id             INT           NOT NULL,
  sort_order                INT           NOT NULL DEFAULT 0,
  basis                     VARCHAR(20)   NOT NULL DEFAULT 'PER_YEAR',
  days                      DECIMAL(6,2)  NULL,
  accrual                   VARCHAR(20)   NOT NULL DEFAULT 'UPFRONT',
  days_worked_per_leave_day INT           NULL,
  prorate_on_joining        TINYINT(1)    NOT NULL DEFAULT 0,
  joining_cutoff_day        TINYINT       NULL,                 -- §24
  credit_in_arrears         TINYINT(1)    NOT NULL DEFAULT 0,   -- §24
  allowed_in_probation      TINYINT(1)    NOT NULL DEFAULT 1,
  wait_days_after_joining   INT           NOT NULL DEFAULT 0,
  carry_forward             VARCHAR(20)   NOT NULL DEFAULT 'NONE',
  carry_forward_cap_days    DECIMAL(6,2)  NULL,
  encashable                TINYINT(1)    NOT NULL DEFAULT 0,
  encash_cap_days           DECIMAL(6,2)  NULL,
  max_days_at_once          DECIMAL(6,2)  NULL,
  min_notice_days           INT           NOT NULL DEFAULT 0,
  notice_tiers_json         JSON          NULL,                 -- §24
  not_with_json             JSON          NULL,                 -- §24
  half_day_allowed          TINYINT(1)    NOT NULL DEFAULT 0,
  count_days_off_between    TINYINT(1)    NOT NULL DEFAULT 0,
  proof_after_days          DECIMAL(6,2)  NULL,                 -- NULL = never
  applies_to                VARCHAR(20)   NOT NULL DEFAULT 'ANYONE',
  max_times_in_service      INT           NULL,                 -- NULL = no limit
  expires_after_days        INT           NULL,
  negative_balance_allowed  TINYINT(1)    NOT NULL DEFAULT 0,
  notes                     VARCHAR(500)  NULL,

  deleted_at                DATETIME      DEFAULT NULL,         -- never set; a rule is replaced with its set
  created_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by                INT           NULL,

  UNIQUE KEY uq_hlpr_tenant (company_id, id),
  UNIQUE KEY uq_hlpr_type   (company_id, policy_id, leave_type_id),
  KEY idx_hlpr_leave_type (company_id, leave_type_id),

  CONSTRAINT fk_hlpr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlpr_policy  FOREIGN KEY (company_id, policy_id)     REFERENCES hrms_leave_policies(company_id, id),
  CONSTRAINT fk_hlpr_type    FOREIGN KEY (company_id, leave_type_id) REFERENCES hrms_leave_types(company_id, id),
  CONSTRAINT fk_hlpr_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ----- 13c. Leave policy assignments -------------------------------------------
-- Where a policy applies. scope COMPANY (both ids NULL), LOCATION (location_id),
-- ROLE (role_id) or LABEL (label_id, a department label — spec §17, §19 below).
-- ONE LIVE ROW PER TARGET is a database guarantee: `target_key` is 'COMPANY:0',
-- 'LOCATION:<id>', 'ROLE:<id>' or 'LABEL:<id>' while the row is live and NULL
-- once it is removed. label_id's foreign key is added in §19 (the labels table
-- is created below this one); on a database made before §17, §19 also adds the
-- column and rebuilds target_key with label_id in it.

CREATE TABLE IF NOT EXISTS hrms_leave_policy_assignments (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  scope        VARCHAR(20)  NOT NULL,                 -- COMPANY | LOCATION | ROLE | LABEL
  location_id  INT          NULL,
  role_id      INT          NULL,
  label_id     INT          NULL,
  policy_id    INT          NOT NULL,

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  target_key   VARCHAR(40)  GENERATED ALWAYS AS (
                 IF(deleted_at IS NULL, CONCAT(scope, ':', IFNULL(location_id, IFNULL(role_id, IFNULL(label_id, 0)))), NULL)) VIRTUAL,

  UNIQUE KEY uq_hlpa_tenant (company_id, id),
  UNIQUE KEY uq_hlpa_target (company_id, target_key),
  KEY idx_hlpa_policy (company_id, policy_id),
  KEY idx_hlpa_label (company_id, label_id),

  CONSTRAINT fk_hlpa_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlpa_policy   FOREIGN KEY (company_id, policy_id)   REFERENCES hrms_leave_policies(company_id, id),
  CONSTRAINT fk_hlpa_location FOREIGN KEY (company_id, location_id) REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hlpa_role     FOREIGN KEY (company_id, role_id)     REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hlpa_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 14. DEPARTMENT LABELS (CF_HRMS_HIRING_SPEC.md §9, 2026-10-12)            ##
-- ############################################################################
-- Everything is a department. A department carries a LABEL
-- (hrms_departments.department_type, text, still never branched on) and a
-- separate fact, is_shared. The label is chosen from the company's own short
-- list, which is this table. A new company starts with Department, Section,
-- Machine; they are written the first time the list is read
-- (services/departmentLabelService.js), so a company never has an empty list.
--
-- The department keeps the label's NAME, not its id: renaming a label renames it
-- on every department that uses it, in the same transaction, and every read that
-- already prints department_type goes on working untouched.
--
-- Unique name per company, without case, among live rows (name_active).
CREATE TABLE IF NOT EXISTS hrms_department_labels (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  name         VARCHAR(40)  NOT NULL,
  sort_order   INT          NOT NULL DEFAULT 0,

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  name_active  VARCHAR(40)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hdlb_tenant (company_id, id),
  UNIQUE KEY uq_hdlb_name   (company_id, name_active),
  KEY idx_hdlb_order (company_id, sort_order),

  CONSTRAINT fk_hdlb_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hdlb_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 15. ACCESS ROLES (CF_HRMS_HIRING_SPEC.md section 12, 2026-10-12)         ##
-- ############################################################################
-- An access role is a PLATFORM role (a `roles` row of the company) plus what
-- this app adds to it: the label people see, a description, and its SCOPE.
--
--   scope = COMPANY      the rights apply everywhere
--   scope = DEPARTMENT   they apply to the login own department and below
--                        (services/accessScope.js)
--
-- The RIGHTS themselves are not here. They are ordinary platform rows:
-- role_capability -> features_capability -> features, one single-feature
-- capability per tag, granted for THIS company and THIS app only. This table
-- never grants anything; a role with no row here keeps the whole company as its
-- scope, which is what every role had before this table existed.
--
-- template_key marks a ready-made role (OWNER, HR_MANAGER, HR_EXECUTIVE,
-- DEPARTMENT_HEAD, EMPLOYEE). is_locked: its rights cannot be changed and it
-- cannot be deleted (Owner and Employee).
--
-- One live row per platform role (role_active).
CREATE TABLE IF NOT EXISTS hrms_access_roles (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  role_id       INT           NOT NULL,                 -- roles.id, of the same company
  label         VARCHAR(100)  NOT NULL,
  description   VARCHAR(500)  NULL,
  scope         VARCHAR(20)   NOT NULL DEFAULT 'COMPANY',   -- COMPANY | DEPARTMENT
  template_key  VARCHAR(30)   NULL,
  is_locked     TINYINT(1)    NOT NULL DEFAULT 0,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  role_active   INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, role_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hacr_tenant (company_id, id),
  UNIQUE KEY uq_hacr_role   (company_id, role_active),
  KEY idx_hacr_template (company_id, template_key),

  CONSTRAINT fk_hacr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hacr_role    FOREIGN KEY (role_id)    REFERENCES roles(id),
  CONSTRAINT fk_hacr_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 16. SEARCH BY MEANING (org chart "Search job content", 2026-10-15)       ##
-- ############################################################################
-- One sentence vector per KRA / responsibility / KPI / qualification definition,
-- made by the built-in model (services/semantic/embedder.js — nothing leaves the
-- server). `text_hash` is the SHA-256 of the exact text embedded (name + ' ' +
-- description); a definition whose text changed no longer matches its hash and
-- is re-embedded (services/semantic/searchIndex.js). `model` keys the row, so a
-- different model builds its own rows and never mixes with these.
--
-- `vector` is `dims` Float32 values, little-endian (384 x 4 = 1,536 bytes).
-- `kind` is a VARCHAR, not an ENUM: RESPONSIBILITY | KRA | KPI | QUALIFICATION.
-- deleted_at is there because every hrms_ table has one (the test suites and the
-- tenant tools count live rows by it); the code never soft-deletes a vector — a
-- row is derived data, rebuilt at will, and a deleted definition simply stops
-- being looked up. A row with deleted_at set is ignored and revived by an upsert.
CREATE TABLE IF NOT EXISTS hrms_search_vectors (
  id             BIGINT        AUTO_INCREMENT PRIMARY KEY,
  company_id     INT           NOT NULL,
  kind           VARCHAR(20)   NOT NULL,
  definition_id  INT           NOT NULL,
  text_hash      CHAR(64)      NOT NULL,
  model          VARCHAR(80)   NOT NULL,
  dims           SMALLINT      NOT NULL,
  vector         BLOB          NOT NULL,
  deleted_at     DATETIME      DEFAULT NULL,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_hsv_def (company_id, kind, definition_id, model),
  KEY idx_hsv_model (company_id, model),

  CONSTRAINT fk_hsv_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 17. LABELS IN GROUPS (CF_HRMS_HIRING_SPEC.md §15, 2026-10-15)           ##
-- ############################################################################
-- 2026-10-16: GROUPS WERE REMOVED — a department has exactly ONE label, always.
-- The tables below stay as they are (no schema churn): every company keeps one
-- hrms_label_groups row, its is_kind group, and every label lives in it. The
-- code reads and writes only that group (services/labelGroupService.js); the
-- department's label is department_type (its name), with a link row beside it.
-- What follows describes the model as it was built on 2026-10-15.
--
-- A department's labels belong to named GROUPS, one label per group per
-- department. Every company has the group "Kind" (required); its labels are the
-- Department / Section / Machine list of §14. Other groups are the company's
-- own ("Unit": Unit 1, Unit 2 …) and may be optional (a department may have
-- none of that group).
--
--   hrms_label_groups            the groups, in the company's order
--   hrms_department_labels       (§14) gains group_id: a label belongs to ONE group;
--                                its name is unique WITHIN the group
--   hrms_department_label_links  department -> its label in a group; ONE live
--                                link per (department, group) (group_active)
--
-- hrms_departments.department_type STAYS and is kept equal to the department's
-- Kind label name: writes go through the links and mirror into it in the same
-- transaction (services/labelGroupService.js), so every older reader of the
-- column — code-format conditions, the chart, the command bar — keeps working.
--
-- On a database that already has §14, scripts/apply-label-groups.mjs makes the
-- Kind group per company, moves the labels into it and links every department
-- from its department_type. It is idempotent and safe to run again after a
-- deploy (it relinks any department written by an older backend meanwhile).
--
-- group_id is NULL-able on purpose: an older backend that is still running when
-- the columns arrive inserts labels without it; the script (and the service,
-- on first read) moves such a label into Kind.
CREATE TABLE IF NOT EXISTS hrms_label_groups (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  name         VARCHAR(40)  NOT NULL,
  sort_order   INT          NOT NULL DEFAULT 0,
  is_required  TINYINT(1)   NOT NULL DEFAULT 0,
  is_kind      TINYINT(1)   NOT NULL DEFAULT 0,       -- the company's Kind group: never removed, always required

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  name_active  VARCHAR(40)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,
  kind_active  TINYINT      GENERATED ALWAYS AS (IF(deleted_at IS NULL AND is_kind = 1, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_hlgr_tenant (company_id, id),
  UNIQUE KEY uq_hlgr_name   (company_id, name_active),
  UNIQUE KEY uq_hlgr_kind   (company_id, kind_active),
  KEY idx_hlgr_order (company_id, sort_order),

  CONSTRAINT fk_hlgr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlgr_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 17a. hrms_department_labels.group_id ----------------------------------
-- One change per ALTER (TiDB, see §10c).
SET @needs_label_group = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_department_labels'
     AND COLUMN_NAME  = 'group_id');
SET @sql = IF(@needs_label_group = 1,
  'ALTER TABLE hrms_department_labels ADD COLUMN group_id INT NULL AFTER company_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- A label's name is unique within its group (was: within the company).
SET @needs_label_group_key = (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_department_labels'
     AND INDEX_NAME   = 'uq_hdlb_group_name');
SET @sql = IF(@needs_label_group_key = 1,
  'ALTER TABLE hrms_department_labels ADD UNIQUE KEY uq_hdlb_group_name (company_id, group_id, name_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @has_label_name_key = (
  SELECT COUNT(*) > 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hrms_department_labels'
     AND INDEX_NAME   = 'uq_hdlb_name');
SET @sql = IF(@has_label_name_key = 1,
  'ALTER TABLE hrms_department_labels DROP INDEX uq_hdlb_name',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 17b. a department's label in each group -------------------------------
CREATE TABLE IF NOT EXISTS hrms_department_label_links (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  company_id     INT          NOT NULL,
  department_id  INT          NOT NULL,
  group_id       INT          NOT NULL,
  label_id       INT          NOT NULL,

  deleted_at     DATETIME     DEFAULT NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT          NULL,

  group_active   INT          GENERATED ALWAYS AS (IF(deleted_at IS NULL, group_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hdll_tenant (company_id, id),
  UNIQUE KEY uq_hdll_one    (company_id, department_id, group_active),
  KEY idx_hdll_label (company_id, label_id),
  KEY idx_hdll_group (company_id, group_id),

  CONSTRAINT fk_hdll_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hdll_department FOREIGN KEY (company_id, department_id) REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_hdll_group      FOREIGN KEY (company_id, group_id)      REFERENCES hrms_label_groups(company_id, id),
  CONSTRAINT fk_hdll_label      FOREIGN KEY (company_id, label_id)      REFERENCES hrms_department_labels(company_id, id),
  CONSTRAINT fk_hdll_creator    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 18. DATED HISTORY OF JOB CONTENT (CF_HRMS_HIRING_SPEC.md §16, 2026-10-15)
-- ############################################################################
-- "Never overwrite old expectations." Every change to a KRA, responsibility or
-- KPI line - on a role, on a position, or for one person - closes the old row
-- (effective_to = the day before) and opens a new one (effective_from = the
-- day it takes effect). Nothing job-related is deleted.
--
--   line_key       a line's identity across its versions: a reworded line is
--                  "this line, reworded", not a new one. Role rows carry their
--                  own; a position's or a person's change of a role line carries
--                  the role line's key, so history can tell one line's story
--                  through all three layers. Backfilled by
--                  apps/cf_hrms/scripts/apply-history-schema.mjs.
--   ended_by       who closed the row (the opener is created_by).
--   change_reason  role rows only: why a change was dated in the past (the
--                  Owner's reason). Overlay rows already have their reason.
--
-- One change per ALTER (TiDB, see §10c). Guarded: safe on an old database and
-- a no-op the second time.

-- ----- 18. hrms_role_kra_assignments -----------------------------------------
SET @needs_hrka_line_key = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kra_assignments' AND COLUMN_NAME = 'line_key');
SET @sql = IF(@needs_hrka_line_key = 1,
  'ALTER TABLE hrms_role_kra_assignments ADD COLUMN line_key VARCHAR(40) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrka_ended_by = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kra_assignments' AND COLUMN_NAME = 'ended_by');
SET @sql = IF(@needs_hrka_ended_by = 1,
  'ALTER TABLE hrms_role_kra_assignments ADD COLUMN ended_by INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrka_change_reason = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kra_assignments' AND COLUMN_NAME = 'change_reason');
SET @sql = IF(@needs_hrka_change_reason = 1,
  'ALTER TABLE hrms_role_kra_assignments ADD COLUMN change_reason VARCHAR(500) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrka_line_idx = (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kra_assignments' AND INDEX_NAME = 'idx_hrka_line');
SET @sql = IF(@needs_hrka_line_idx = 1,
  'ALTER TABLE hrms_role_kra_assignments ADD KEY idx_hrka_line (company_id, line_key)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 18. hrms_role_responsibility_assignments ------------------------------
SET @needs_hrra_line_key = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_responsibility_assignments' AND COLUMN_NAME = 'line_key');
SET @sql = IF(@needs_hrra_line_key = 1,
  'ALTER TABLE hrms_role_responsibility_assignments ADD COLUMN line_key VARCHAR(40) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrra_ended_by = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_responsibility_assignments' AND COLUMN_NAME = 'ended_by');
SET @sql = IF(@needs_hrra_ended_by = 1,
  'ALTER TABLE hrms_role_responsibility_assignments ADD COLUMN ended_by INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrra_change_reason = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_responsibility_assignments' AND COLUMN_NAME = 'change_reason');
SET @sql = IF(@needs_hrra_change_reason = 1,
  'ALTER TABLE hrms_role_responsibility_assignments ADD COLUMN change_reason VARCHAR(500) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrra_line_idx = (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_responsibility_assignments' AND INDEX_NAME = 'idx_hrra_line');
SET @sql = IF(@needs_hrra_line_idx = 1,
  'ALTER TABLE hrms_role_responsibility_assignments ADD KEY idx_hrra_line (company_id, line_key)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 18. hrms_role_kpi_assignments -----------------------------------------
SET @needs_hrkp_line_key = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kpi_assignments' AND COLUMN_NAME = 'line_key');
SET @sql = IF(@needs_hrkp_line_key = 1,
  'ALTER TABLE hrms_role_kpi_assignments ADD COLUMN line_key VARCHAR(40) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrkp_ended_by = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kpi_assignments' AND COLUMN_NAME = 'ended_by');
SET @sql = IF(@needs_hrkp_ended_by = 1,
  'ALTER TABLE hrms_role_kpi_assignments ADD COLUMN ended_by INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrkp_change_reason = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kpi_assignments' AND COLUMN_NAME = 'change_reason');
SET @sql = IF(@needs_hrkp_change_reason = 1,
  'ALTER TABLE hrms_role_kpi_assignments ADD COLUMN change_reason VARCHAR(500) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hrkp_line_idx = (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kpi_assignments' AND INDEX_NAME = 'idx_hrkp_line');
SET @sql = IF(@needs_hrkp_line_idx = 1,
  'ALTER TABLE hrms_role_kpi_assignments ADD KEY idx_hrkp_line (company_id, line_key)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 18. hrms_position_content_overrides -----------------------------------
SET @needs_hpco_line_key = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_position_content_overrides' AND COLUMN_NAME = 'line_key');
SET @sql = IF(@needs_hpco_line_key = 1,
  'ALTER TABLE hrms_position_content_overrides ADD COLUMN line_key VARCHAR(40) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hpco_ended_by = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_position_content_overrides' AND COLUMN_NAME = 'ended_by');
SET @sql = IF(@needs_hpco_ended_by = 1,
  'ALTER TABLE hrms_position_content_overrides ADD COLUMN ended_by INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hpco_line_idx = (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_position_content_overrides' AND INDEX_NAME = 'idx_hpco_line');
SET @sql = IF(@needs_hpco_line_idx = 1,
  'ALTER TABLE hrms_position_content_overrides ADD KEY idx_hpco_line (company_id, line_key)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 18. hrms_work_assignment_content_overrides ----------------------------
SET @needs_hwco_line_key = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_work_assignment_content_overrides' AND COLUMN_NAME = 'line_key');
SET @sql = IF(@needs_hwco_line_key = 1,
  'ALTER TABLE hrms_work_assignment_content_overrides ADD COLUMN line_key VARCHAR(40) NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hwco_ended_by = (
  SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_work_assignment_content_overrides' AND COLUMN_NAME = 'ended_by');
SET @sql = IF(@needs_hwco_ended_by = 1,
  'ALTER TABLE hrms_work_assignment_content_overrides ADD COLUMN ended_by INT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @needs_hwco_line_idx = (
  SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_work_assignment_content_overrides' AND INDEX_NAME = 'idx_hwco_line');
SET @sql = IF(@needs_hwco_line_idx = 1,
  'ALTER TABLE hrms_work_assignment_content_overrides ADD KEY idx_hwco_line (company_id, line_key)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 19. LEAVE POLICY AND DEFAULT SHIFT BY LABEL (CF_HRMS_HIRING_SPEC.md §17)  ##
-- ############################################################################
-- Added 2026-10-15.
--
--   hrms_leave_policy_assignments  scope LABEL with label_id: a policy for every
--                                  position whose department carries the label.
--                                  The resolution is role -> label -> location ->
--                                  company (services/leavePolicyRead.js).
--                                  target_key gains label_id, so 'LABEL:<id>' is
--                                  one live row per label. `scope` is already
--                                  VARCHAR(20): LABEL needs no change to it.
--   hrms_department_labels         default_shift_id ("New positions start on"):
--                                  the shift a NEW position gets when none is
--                                  named — its department's label's, when it has
--                                  one; else the General shift. Existing
--                                  positions never change.
--
-- One change per ALTER (TiDB, see §10c). Every step is guarded: a no-op on a
-- database that has it, including one built from this file a moment ago.
-- apps/cf_hrms/scripts/apply-label-defaults.mjs makes exactly these changes.

-- ----- 19a. hrms_leave_policy_assignments.label_id ---------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'label_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_assignments ADD COLUMN label_id INT NULL AFTER role_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND INDEX_NAME = 'idx_hlpa_label');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_assignments ADD KEY idx_hlpa_label (company_id, label_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND CONSTRAINT_NAME = 'fk_hlpa_label');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_assignments ADD CONSTRAINT fk_hlpa_label FOREIGN KEY (company_id, label_id) REFERENCES hrms_department_labels(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 19b. target_key with label_id in it -----------------------------------
-- TiDB cannot change a generated column's expression, so a target_key that does
-- not mention label_id yet is dropped (its unique key first) and added again.
-- COMPANY, LOCATION and ROLE rows get exactly the key they had.
SET @old_target = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'target_key'
             AND GENERATION_EXPRESSION NOT LIKE '%label_id%');
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND INDEX_NAME = 'uq_hlpa_target');
SET @sql = IF(@old_target > 0 AND @c > 0, 'ALTER TABLE hrms_leave_policy_assignments DROP INDEX uq_hlpa_target', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(@old_target > 0, 'ALTER TABLE hrms_leave_policy_assignments DROP COLUMN target_key', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND COLUMN_NAME = 'target_key');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_assignments ADD COLUMN target_key VARCHAR(40) GENERATED ALWAYS AS (IF(deleted_at IS NULL, CONCAT(scope, '':'', IFNULL(location_id, IFNULL(role_id, IFNULL(label_id, 0)))), NULL)) VIRTUAL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_assignments' AND INDEX_NAME = 'uq_hlpa_target');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_assignments ADD UNIQUE KEY uq_hlpa_target (company_id, target_key)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 19c. hrms_department_labels.default_shift_id --------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_department_labels' AND COLUMN_NAME = 'default_shift_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_department_labels ADD COLUMN default_shift_id INT NULL AFTER sort_order', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_department_labels' AND INDEX_NAME = 'idx_hdlb_default_shift');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_department_labels ADD KEY idx_hdlb_default_shift (company_id, default_shift_id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_department_labels' AND CONSTRAINT_NAME = 'fk_hdlb_default_shift');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_department_labels ADD CONSTRAINT fk_hdlb_default_shift FOREIGN KEY (company_id, default_shift_id) REFERENCES hrms_shifts(company_id, id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 20. PERFORMANCE PLANS (CF_HRMS_HIRING_SPEC.md §18)                       ##
-- ############################################################################
-- Added 2026-10-15. KRAs and KPIs stay on the job (role -> position -> person,
-- §16). Each period a PLAN is created for each employee by copying the KRA
-- headings and KPIs from their job AS IT STOOD ON THE PERIOD'S START (through
-- services/contentResolver.js, the one resolver); the manager changes only what
-- differs. Responsibilities are not copied: they are the JD, not the scorecard.
--
--   hrms_performance_settings        one row per company: the performance year's
--                                    first month, the frequency of a role that has
--                                    none, the rating scale (used from step 6).
--   hrms_roles.performance_frequency MONTHLY | QUARTERLY | HALF_YEARLY | YEARLY,
--                                    NULL = the company default.
--   hrms_performance_periods         made on demand from a frequency and the year
--                                    start ("Q3 2026-27", "Oct 2026"); one per
--                                    (company, frequency, start) and never
--                                    overlapping for one frequency (service rule).
--   hrms_performance_plans           one live plan per (employee, period) — a
--                                    CANCELLED plan is kept and frees the slot.
--                                    The position held on the day the job was
--                                    read is a snapshot (position, role,
--                                    department, the manager's position).
--   hrms_performance_plan_kras       the KRA headings, copied; weight per plan.
--   hrms_performance_plan_kpis       the KPIs, copied; `job_*` is what the job
--                                    said, kept beside what the plan says, so
--                                    "changed for this period" can show both.
--                                    Actuals (step 5) and reviews (step 6) attach
--                                    to a plan KPI's id: nothing here changes then.
--   hrms_performance_target_changes  a target changed AFTER activation: dated,
--                                    with a reason, never overwritten.
--
-- Status and kind columns are VARCHAR, not ENUM; the services hold the lists.
-- New tables: CREATE TABLE IF NOT EXISTS reaches old and new databases alike.
-- The one change to an existing table is a guarded ALTER.
-- apps/cf_hrms/scripts/apply-performance-schema.mjs makes exactly these changes.

-- ----- 20a. hrms_roles.performance_frequency --------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_roles' AND COLUMN_NAME = 'performance_frequency');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_roles ADD COLUMN performance_frequency VARCHAR(20) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 20b. Settings ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_settings (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  year_start_month   TINYINT      NOT NULL DEFAULT 4,              -- 1..12; India: April
  default_frequency  VARCHAR(20)  NOT NULL DEFAULT 'QUARTERLY',
  rating_scale       JSON         NULL,                            -- [{ value, label }] low to high

  deleted_at         DATETIME     DEFAULT NULL,                    -- never written; every hrms_ table has it
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,
  updated_by         INT          NULL,

  UNIQUE KEY uq_hpfs_company (company_id),
  CONSTRAINT fk_hpfs_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfs_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_hpfs_updater FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 20c. Periods ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_periods (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  company_id  INT          NOT NULL,
  frequency   VARCHAR(20)  NOT NULL,                               -- MONTHLY | QUARTERLY | HALF_YEARLY | YEARLY
  name        VARCHAR(40)  NOT NULL,                               -- "Q3 2026-27", "Oct 2026", "H2 2026-27", "2026-27"
  start_date  DATE         NOT NULL,
  end_date    DATE         NOT NULL,
  status      VARCHAR(10)  NOT NULL DEFAULT 'OPEN',                -- OPEN | CLOSED
  closed_at   DATETIME     NULL,
  closed_by   INT          NULL,

  deleted_at  DATETIME     DEFAULT NULL,                           -- never written: a period is closed, not removed
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by  INT          NULL,

  UNIQUE KEY uq_hpfp_tenant (company_id, id),
  UNIQUE KEY uq_hpfp_start  (company_id, frequency, start_date),
  KEY idx_hpfp_dates (company_id, frequency, start_date, end_date),

  CONSTRAINT fk_hpfp_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfp_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_hpfp_closer  FOREIGN KEY (closed_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 20d. Plans -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_plans (
  id                   INT          AUTO_INCREMENT PRIMARY KEY,
  company_id           INT          NOT NULL,
  period_id            INT          NOT NULL,
  employee_id          INT          NOT NULL,
  -- The day the job was read: the period start, or the first day in the
  -- position for a person who joined during the period. A snapshot.
  copied_on            DATE         NOT NULL,
  work_assignment_id   INT          NULL,
  position_id          INT          NULL,
  role_id              INT          NULL,
  department_id        INT          NULL,
  manager_position_id  INT          NULL,
  position_code        VARCHAR(60)  NULL,
  position_title       VARCHAR(250) NULL,
  role_title           VARCHAR(200) NULL,
  department_name      VARCHAR(200) NULL,
  status               VARCHAR(12)  NOT NULL DEFAULT 'DRAFT',      -- DRAFT | ACTIVE | CLOSED | CANCELLED
  no_kpis              TINYINT(1)   NOT NULL DEFAULT 0,            -- the job had no KPIs on that day
  activated_at         DATETIME     NULL,
  activated_by         INT          NULL,
  closed_at            DATETIME     NULL,
  cancelled_at         DATETIME     NULL,
  cancelled_by         INT          NULL,
  cancel_reason        VARCHAR(500) NULL,

  deleted_at           DATETIME     DEFAULT NULL,                -- never written: a plan is CANCELLED, not deleted
  created_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by           INT          NULL,

  -- One live plan per person per period; a cancelled one is kept and frees the slot.
  live_employee        INT          GENERATED ALWAYS AS (IF(status <> 'CANCELLED', employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpfl_tenant (company_id, id),
  UNIQUE KEY uq_hpfl_one    (company_id, period_id, live_employee),
  KEY idx_hpfl_period   (company_id, period_id, status),
  KEY idx_hpfl_employee (company_id, employee_id),
  KEY idx_hpfl_position (company_id, position_id),

  CONSTRAINT fk_hpfl_company    FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfl_period     FOREIGN KEY (company_id, period_id)          REFERENCES hrms_performance_periods(company_id, id),
  CONSTRAINT fk_hpfl_employee   FOREIGN KEY (company_id, employee_id)        REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpfl_assignment FOREIGN KEY (company_id, work_assignment_id) REFERENCES hrms_work_assignments(company_id, id),
  CONSTRAINT fk_hpfl_position   FOREIGN KEY (company_id, position_id)        REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_hpfl_role       FOREIGN KEY (company_id, role_id)            REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hpfl_creator    FOREIGN KEY (created_by)   REFERENCES users(id),
  CONSTRAINT fk_hpfl_activator  FOREIGN KEY (activated_by) REFERENCES users(id),
  CONSTRAINT fk_hpfl_canceller  FOREIGN KEY (cancelled_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 20e. Plan KRAs ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_plan_kras (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  plan_id            INT          NOT NULL,
  name               VARCHAR(250) NOT NULL,
  kra_definition_id  INT          NULL,
  line_key           VARCHAR(40)  NULL,                            -- the job line it came from; NULL = added on the plan
  weight_percent     DECIMAL(5,2) NULL,
  job_weight_percent DECIMAL(5,2) NULL,                            -- what the job said
  added_on_plan      TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order         INT          NOT NULL DEFAULT 0,

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  UNIQUE KEY uq_hpfk_tenant (company_id, id),
  KEY idx_hpfk_plan (company_id, plan_id, sort_order),

  CONSTRAINT fk_hpfk_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfk_plan    FOREIGN KEY (company_id, plan_id) REFERENCES hrms_performance_plans(company_id, id),
  CONSTRAINT fk_hpfk_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 20f. Plan KPIs ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_plan_kpis (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plan_id            INT           NOT NULL,
  plan_kra_id        INT           NULL,                           -- NULL = not under a KRA
  name               VARCHAR(250)  NOT NULL,
  kpi_definition_id  INT           NULL,
  line_key           VARCHAR(40)   NULL,                           -- the job line it came from; NULL = added on the plan
  unit               VARCHAR(30)   NULL,                           -- "%", "hours", "count", "₹"
  direction          VARCHAR(16)   NOT NULL DEFAULT 'TEXT',        -- HIGHER_BETTER | LOWER_BETTER | EXACT | TEXT
  target_number      DECIMAL(18,4) NULL,                           -- a range: its lowest (§25)
  target_max         DECIMAL(18,4) NULL,                           -- a range: its highest (§25)
  target_date        DATE          NULL,                           -- direction DATE: done on or before (§25)
  target_text        VARCHAR(500)  NULL,
  entry_frequency    VARCHAR(20)   NULL,                           -- how often actuals are entered; NULL = the plan's
  weight_percent     DECIMAL(5,2)  NULL,                           -- within its KRA
  sort_order         INT           NOT NULL DEFAULT 0,
  added_on_plan      TINYINT(1)    NOT NULL DEFAULT 0,
  changed_on_plan    TINYINT(1)    NOT NULL DEFAULT 0,
  -- What the job said on the day it was copied (NULL for one added on the plan).
  job_unit           VARCHAR(30)   NULL,
  job_direction      VARCHAR(16)   NULL,
  job_target_number  DECIMAL(18,4) NULL,
  job_target_max     DECIMAL(18,4) NULL,
  job_target_date    DATE          NULL,
  job_target_text    VARCHAR(500)  NULL,                           -- the job's target as written ("95%", "Max 30 minutes")
  job_weight_percent DECIMAL(5,2)  NULL,

  deleted_at         DATETIME      DEFAULT NULL,                   -- removed from a DRAFT plan; kept
  deleted_by         INT           NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  UNIQUE KEY uq_hpfi_tenant (company_id, id),
  KEY idx_hpfi_plan (company_id, plan_id, sort_order),
  KEY idx_hpfi_kra  (company_id, plan_kra_id),

  CONSTRAINT fk_hpfi_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfi_plan    FOREIGN KEY (company_id, plan_id)     REFERENCES hrms_performance_plans(company_id, id),
  CONSTRAINT fk_hpfi_kra     FOREIGN KEY (company_id, plan_kra_id) REFERENCES hrms_performance_plan_kras(company_id, id),
  CONSTRAINT fk_hpfi_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 20g. Target changes after activation -------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_target_changes (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  plan_id         INT           NOT NULL,
  plan_kpi_id     INT           NOT NULL,
  effective_from  DATE          NOT NULL,
  from_number     DECIMAL(18,4) NULL,
  from_max        DECIMAL(18,4) NULL,
  from_date       DATE          NULL,
  from_text       VARCHAR(500)  NULL,
  from_direction  VARCHAR(16)   NULL,
  to_number       DECIMAL(18,4) NULL,
  to_max          DECIMAL(18,4) NULL,
  to_date         DATE          NULL,
  to_text         VARCHAR(500)  NULL,
  to_direction    VARCHAR(16)   NULL,
  reason          VARCHAR(500)  NOT NULL,

  deleted_at      DATETIME      DEFAULT NULL,                    -- never written: a change is never undone, only followed
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  UNIQUE KEY uq_hpft_tenant (company_id, id),
  KEY idx_hpft_kpi  (company_id, plan_kpi_id, effective_from),
  KEY idx_hpft_plan (company_id, plan_id),

  CONSTRAINT fk_hpft_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpft_plan    FOREIGN KEY (company_id, plan_id)     REFERENCES hrms_performance_plans(company_id, id),
  CONSTRAINT fk_hpft_kpi     FOREIGN KEY (company_id, plan_kpi_id) REFERENCES hrms_performance_plan_kpis(company_id, id),
  CONSTRAINT fk_hpft_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 21. ACTUALS AGAINST PERFORMANCE PLANS (CF_HRMS_HIRING_SPEC.md §19)       ##
-- ############################################################################
-- Added 2026-10-15. An ACTUAL is what a person achieved on one plan KPI for one
-- SLOT — the sub-period it is for: a KPI entered monthly in a quarterly plan
-- has three slots ("Oct 2026", "Nov 2026", "Dec 2026"); a KPI entered once per
-- plan has one slot, the period itself. Slots are computed
-- (services/performance/slots.js), never stored on their own: an actual keeps
-- its slot's first and last day.
--
--   hrms_performance_actuals             NEVER OVERWRITTEN. A correction closes
--                                        the live row (closed_at / closed_by)
--                                        and opens a new one that points at it
--                                        (corrects_id) and says why
--                                        (correction_reason). One LIVE row per
--                                        (plan KPI, slot): `live_slot` is the
--                                        slot's first day while the row is
--                                        live, NULL once closed, and is unique.
--   hrms_performance_plan_kpis.combine_rule
--                                        SUM | AVERAGE | LAST — how a KPI's
--                                        slots make one actual. Set from the
--                                        unit when a plan is made (%, minutes,
--                                        hours, days -> AVERAGE; counts, MT, m,
--                                        ₹ -> SUM; words -> AVERAGE of met /
--                                        not met); NULL on an older row = the
--                                        same default, and
--                                        apply-actuals-schema.mjs fills it in.
--   hrms_performance_settings.band_on_track / band_at_risk
--                                        the status bands, in % of achievement:
--                                        on track >= 90, at risk >= 70, behind
--                                        below that (the defaults).
--
-- Achievement, KRA and plan scores are COMPUTED ON READ and never stored
-- (services/performance/scoring.js — one place, used by every read).
-- apps/cf_hrms/scripts/apply-actuals-schema.mjs makes exactly these changes.

-- ----- 21a. hrms_performance_plan_kpis.combine_rule ----------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_plan_kpis' AND COLUMN_NAME = 'combine_rule');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_plan_kpis ADD COLUMN combine_rule VARCHAR(8) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 21b. the status bands ------------------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_settings' AND COLUMN_NAME = 'band_on_track');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_settings ADD COLUMN band_on_track DECIMAL(5,2) NOT NULL DEFAULT 90.00', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_settings' AND COLUMN_NAME = 'band_at_risk');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_settings ADD COLUMN band_at_risk DECIMAL(5,2) NOT NULL DEFAULT 70.00', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 21c. Actuals ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_actuals (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plan_id            INT           NOT NULL,
  plan_kpi_id        INT           NOT NULL,
  slot_start         DATE          NOT NULL,                       -- the slot's first day
  slot_end           DATE          NOT NULL,                       -- and its last
  value_number       DECIMAL(18,4) NULL,                           -- a KPI with a number target
  value_text         VARCHAR(500)  NULL,                           -- words, beside met / not met
  met                VARCHAR(3)    NULL,                           -- YES | NO, for a target written as words
  note               VARCHAR(1000) NULL,
  source             VARCHAR(10)   NOT NULL DEFAULT 'MANUAL',      -- MANUAL | EXCEL | SYSTEM | FORMULA
  entered_by         INT           NULL,
  entered_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  corrects_id        INT           NULL,                           -- the row this one corrects
  correction_reason  VARCHAR(500)  NULL,                           -- why (required for a correction)
  closed_at          DATETIME(3)   NULL,                           -- set when a correction replaces it
  closed_by          INT           NULL,

  deleted_at         DATETIME      DEFAULT NULL,                   -- never written: an actual is corrected, not removed
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,

  -- One live row per (plan KPI, slot); closed rows are kept beside it.
  live_slot          DATE          GENERATED ALWAYS AS (IF(closed_at IS NULL, slot_start, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpfa_tenant (company_id, id),
  UNIQUE KEY uq_hpfa_live   (company_id, plan_kpi_id, live_slot),
  KEY idx_hpfa_plan (company_id, plan_id, closed_at),
  KEY idx_hpfa_kpi  (company_id, plan_kpi_id, slot_start),

  CONSTRAINT fk_hpfa_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfa_plan     FOREIGN KEY (company_id, plan_id)     REFERENCES hrms_performance_plans(company_id, id),
  CONSTRAINT fk_hpfa_kpi      FOREIGN KEY (company_id, plan_kpi_id) REFERENCES hrms_performance_plan_kpis(company_id, id),
  CONSTRAINT fk_hpfa_corrects FOREIGN KEY (company_id, corrects_id) REFERENCES hrms_performance_actuals(company_id, id),
  CONSTRAINT fk_hpfa_enterer  FOREIGN KEY (entered_by) REFERENCES users(id),
  CONSTRAINT fk_hpfa_closer   FOREIGN KEY (closed_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ############################################################################
-- ## 22. CHECK-INS, REVIEWS AND ACTION ITEMS (CF_HRMS_HIRING_SPEC.md §20)     ##
-- ############################################################################
-- Added 2026-10-15. A REVIEW is a conversation about one plan:
--
--   hrms_performance_reviews   kind CHECK_IN (for one slot of the plan, opened by
--                              HR or the manager) | FINAL (one per plan, made by
--                              the app the day the period's last slot opens —
--                              lazily, on read; idempotent). status OPEN ->
--                              EMPLOYEE_DONE (the person wrote their part) ->
--                              DONE (the manager closed it) — or CANCELLED.
--                              A FINAL is due on the period's end + the company's
--                              grace days; a CHECK_IN on its slot's end.
--                              The person writes employee_comment and blockers;
--                              the manager writes manager_comment and, on a
--                              FINAL, the rating — a value of the company's
--                              rating scale, its label kept beside it. A DONE
--                              review is read-only except by the Owner, with a
--                              reason (amended_*). One live review per (plan,
--                              kind, slot): `live_slot` is the slot's first and
--                              last day (1000-01-01 for a FINAL) while the review
--                              is not cancelled, NULL once it is — and is unique.
--   hrms_performance_actions   an action item: raised on a review or on the plan
--                              directly; owner = an employee (usually the
--                              person, sometimes the manager); due date; status
--                              OPEN | DONE | DROPPED; done_on; a note. Overdue =
--                              OPEN and the due date passed (computed on read).
--   hrms_performance_settings.review_grace_days
--                              days after the period's end a FINAL review is due (7).
--
-- The KPIs, actuals, achievement and plan score a review shows are READ, never
-- stored: services/performance/scoring.js through actualsService.js, as on the
-- plan page. apps/cf_hrms/scripts/apply-reviews-schema.mjs makes exactly these
-- changes.

-- ----- 22a. the grace days --------------------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_settings' AND COLUMN_NAME = 'review_grace_days');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_settings ADD COLUMN review_grace_days SMALLINT NOT NULL DEFAULT 7', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 22b. Reviews ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_reviews (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plan_id            INT           NOT NULL,
  kind               VARCHAR(10)   NOT NULL,                       -- CHECK_IN | FINAL
  slot_start         DATE          NULL,                           -- CHECK_IN: its slot; FINAL: NULL (the whole period)
  slot_end           DATE          NULL,
  slot_name          VARCHAR(60)   NULL,
  status             VARCHAR(16)   NOT NULL DEFAULT 'OPEN',        -- OPEN | EMPLOYEE_DONE | DONE | CANCELLED
  due_date           DATE          NOT NULL,
  employee_comment   VARCHAR(4000) NULL,                           -- written by the person
  blockers           VARCHAR(4000) NULL,                           -- blockers / support needed, by the person
  manager_comment    VARCHAR(4000) NULL,
  rating_value       SMALLINT      NULL,                           -- FINAL only: a value of the rating scale
  rating_label       VARCHAR(60)   NULL,                           -- its label, as it was when rated
  opened_by          INT           NULL,                           -- NULL: made by the app (a FINAL)
  employee_done_at   DATETIME      NULL,
  employee_done_by   INT           NULL,
  closed_at          DATETIME      NULL,
  closed_by          INT           NULL,
  cancelled_at       DATETIME      NULL,
  cancelled_by       INT           NULL,
  cancel_reason      VARCHAR(500)  NULL,
  amended_at         DATETIME      NULL,                           -- changed after DONE (the Owner, with a reason)
  amended_by         INT           NULL,
  amend_reason       VARCHAR(500)  NULL,

  deleted_at         DATETIME      DEFAULT NULL,                   -- never written: a review is cancelled, not deleted
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- One live review per (plan, kind, slot — its first and last day); a cancelled one is kept and frees the slot.
  live_slot          VARCHAR(24)   GENERATED ALWAYS AS (IF(status <> 'CANCELLED', CONCAT(COALESCE(slot_start, '1000-01-01'), '/', COALESCE(slot_end, '1000-01-01')), NULL)) VIRTUAL,

  UNIQUE KEY uq_hpfr_tenant (company_id, id),
  UNIQUE KEY uq_hpfr_live   (company_id, plan_id, kind, live_slot),
  KEY idx_hpfr_status (company_id, status, due_date),

  CONSTRAINT fk_hpfr_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfr_plan      FOREIGN KEY (company_id, plan_id) REFERENCES hrms_performance_plans(company_id, id),
  CONSTRAINT fk_hpfr_opener    FOREIGN KEY (opened_by)        REFERENCES users(id),
  CONSTRAINT fk_hpfr_empdone   FOREIGN KEY (employee_done_by) REFERENCES users(id),
  CONSTRAINT fk_hpfr_closer    FOREIGN KEY (closed_by)        REFERENCES users(id),
  CONSTRAINT fk_hpfr_canceller FOREIGN KEY (cancelled_by)     REFERENCES users(id),
  CONSTRAINT fk_hpfr_amender   FOREIGN KEY (amended_by)       REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 22c. Action items ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_performance_actions (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  plan_id            INT           NOT NULL,
  review_id          INT           NULL,                           -- NULL: raised on the plan directly
  owner_employee_id  INT           NOT NULL,                       -- who does it
  action_text        VARCHAR(1000) NOT NULL,
  due_date           DATE          NOT NULL,
  status             VARCHAR(10)   NOT NULL DEFAULT 'OPEN',        -- OPEN | DONE | DROPPED
  done_on            DATE          NULL,
  note               VARCHAR(1000) NULL,
  closed_at          DATETIME      NULL,                           -- when it was done or dropped
  closed_by          INT           NULL,

  deleted_at         DATETIME      DEFAULT NULL,                   -- never written: an action is dropped, not deleted
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,
  updated_by         INT           NULL,

  UNIQUE KEY uq_hpfx_tenant (company_id, id),
  KEY idx_hpfx_plan   (company_id, plan_id),
  KEY idx_hpfx_owner  (company_id, owner_employee_id, status),
  KEY idx_hpfx_status (company_id, status, due_date),

  CONSTRAINT fk_hpfx_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfx_plan    FOREIGN KEY (company_id, plan_id)           REFERENCES hrms_performance_plans(company_id, id),
  CONSTRAINT fk_hpfx_review  FOREIGN KEY (company_id, review_id)         REFERENCES hrms_performance_reviews(company_id, id),
  CONSTRAINT fk_hpfx_owner   FOREIGN KEY (company_id, owner_employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpfx_closer  FOREIGN KEY (closed_by)  REFERENCES users(id),
  CONSTRAINT fk_hpfx_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_hpfx_updater FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 23. LEAVE REQUESTS AND APPROVALS (CF_HRMS_HIRING_SPEC.md §22)          ##
-- ############################################################################
-- Added 2026-10-16. The two leave tables of §8b/§8c are used for the first time:
--
--   hrms_leave_requests   submit = PENDING (no DRAFT is used) -> APPROVED | REJECTED
--                         | CANCELLED (APPROVED -> CANCELLED). Never deleted; every
--                         change writes hrms_audit_log. approver_employee_id is the
--                         person in the chair the main position reports to (vacant:
--                         the next one up; nobody: NULL, and HR decides).
--                         half_day       FIRST | SECOND, one date only
--                         days_json      the counted days as decided at submit
--                         decision_note  the approver's note (needed to reject)
--                         decided_by/at  the login that approved or rejected, and when
--                         cancel_note    why it was cancelled
--                         raised_by_hr   1 when HR asked on the person's behalf
--                         No attendance rows are written: attendance is not built.
--   hrms_leave_balances   ONE ROW = HR's opening balance for a person, a leave type
--                         and a leave year (period_key = the year's key, '2026' or
--                         '2026-27'), with a note. Only opening_balance and note are
--                         read; earned, taken, held and available are computed on read
--                         by services/leave/balance.js and are never stored.
--
-- Declared in the CREATEs of §8b/§8c too (a new database); these guarded ALTERs
-- reach the databases that already exist. One change per ALTER (TiDB, §10c).
-- apps/cf_hrms/scripts/apply-leave-requests-schema.mjs makes exactly these changes.

-- ----- 23a. hrms_leave_requests ----------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'half_day');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN half_day ENUM(''FIRST'',''SECOND'') NULL AFTER approved_at', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'days_json');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN days_json JSON NULL AFTER half_day', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'decision_note');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN decision_note TEXT NULL AFTER days_json', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'decided_by');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN decided_by INT NULL AFTER decision_note', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'decided_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN decided_at DATETIME NULL AFTER decided_by', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'cancel_note');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN cancel_note TEXT NULL AFTER decided_at', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'raised_by_hr');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN raised_by_hr TINYINT(1) NOT NULL DEFAULT 0 AFTER cancel_note', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND CONSTRAINT_NAME = 'fk_hlvr_decider');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD CONSTRAINT fk_hlvr_decider FOREIGN KEY (decided_by) REFERENCES users(id)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 23b. hrms_leave_balances.note -----------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_balances' AND COLUMN_NAME = 'note');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_balances ADD COLUMN note VARCHAR(500) NULL AFTER closing_balance', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 24. LEAVE RULE ADDITIONS — KARNI'S EXECUTIVE POLICY (CF_HRMS_HIRING_SPEC.md §23)
-- ############################################################################
-- Added 2026-10-16. All optional; an old policy reads and behaves exactly as before.
--
--   hrms_leave_policies.effective_from      DATE NULL — nothing is earned before it. Earned
--                                           counts from the latest of the leave-year start,
--                                           joining and this date. A HALF_YEARLY rule gives
--                                           the half that is running on this date in full.
--   hrms_leave_policy_rules.accrual         gains HALF_YEARLY (no column change: VARCHAR).
--   hrms_leave_policy_rules.joining_cutoff_day   someone who joins AFTER this day of a month
--                                           earns nothing for that month (prorating on
--                                           joining; MONTHLY skips the joining month).
--   hrms_leave_policy_rules.credit_in_arrears    MONTHLY: a month's credit is given on the
--                                           first day of the NEXT month.
--   hrms_leave_policy_rules.notice_tiers_json    [{ "upToDays": 3, "days": 7 }, ..., { "days": 45 }]:
--                                           the notice depends on the quantity; replaces
--                                           min_notice_days when set. Still only a NOTE.
--   hrms_leave_policy_rules.not_with_json   [leave type ids]: may not touch this leave
--                                           (overlap, or next to it with only days off between).
--
-- Declared in the CREATEs of §13 too (a new database); these guarded ALTERs reach the
-- databases that already exist. One change per ALTER (TiDB, §10c).
-- apps/cf_hrms/scripts/apply-leave-rules-schema.mjs makes exactly these changes.

-- ----- 24a. hrms_leave_policies -----------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policies' AND COLUMN_NAME = 'effective_from');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policies ADD COLUMN effective_from DATE NULL AFTER year_starts_month', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 24b. hrms_leave_policy_rules -------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_rules' AND COLUMN_NAME = 'joining_cutoff_day');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_rules ADD COLUMN joining_cutoff_day TINYINT NULL AFTER prorate_on_joining', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_rules' AND COLUMN_NAME = 'credit_in_arrears');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_rules ADD COLUMN credit_in_arrears TINYINT(1) NOT NULL DEFAULT 0 AFTER joining_cutoff_day', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_rules' AND COLUMN_NAME = 'notice_tiers_json');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_rules ADD COLUMN notice_tiers_json JSON NULL AFTER min_notice_days', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_rules' AND COLUMN_NAME = 'not_with_json');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_rules ADD COLUMN not_with_json JSON NULL AFTER notice_tiers_json', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 25. STRUCTURED KPI TARGETS (CF_HRMS_HIRING_SPEC.md §24 step 2)           ##
-- ############################################################################
-- Added 2026-10-16. All optional; a KPI without them behaves exactly as before.
--
--   hrms_kpi_definitions.measurement_type   "Measured in" gains WEIGHT, LENGTH and DATE (Percentage ·
--                                           Number · Rupees = CURRENCY · Time = DURATION · Weight · Length
--                                           · Done or not = BOOLEAN · Date / milestone). TEXT = not set.
--   hrms_kpi_definitions.direction          "Which way is better" gains EXACT (HIGHER_BETTER · LOWER_BETTER
--                                           · EXACT · TARGET_RANGE). NEUTRAL / NULL = not set.
--   hrms_role_kpi_assignments.target_json   the structured target of a role line:
--                                           { measure, unit, direction, value | min + max | date }.
--                                           target_value keeps the TEXT (operator EQ): the display and the
--                                           fallback every older reader uses. A position / person line keeps
--                                           its structure in override_json.targetSpec (no column).
--   hrms_performance_plan_kpis              target_max (a range's highest; target_number = its lowest),
--                                           target_date (direction DATE), and the job_ twins.
--   hrms_performance_target_changes         from_max / from_date / to_max / to_date.
--
-- Declared in the CREATEs above too (a new database); these guarded ALTERs reach the databases that
-- already exist. One change per ALTER (TiDB). Appending ENUM values keeps every stored value.
-- apps/cf_hrms/scripts/apply-kpi-targets-schema.mjs makes exactly these changes.

-- ----- 25a. hrms_kpi_definitions: measured in, which way ------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_kpi_definitions' AND COLUMN_NAME = 'measurement_type' AND COLUMN_TYPE LIKE '%''DATE''%');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_kpi_definitions MODIFY COLUMN measurement_type ENUM(''NUMBER'',''PERCENTAGE'',''CURRENCY'',''DURATION'',''BOOLEAN'',''RATING'',''TEXT'',''WEIGHT'',''LENGTH'',''DATE'') NOT NULL DEFAULT ''NUMBER''', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_kpi_definitions' AND COLUMN_NAME = 'direction' AND COLUMN_TYPE LIKE '%''EXACT''%');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_kpi_definitions MODIFY COLUMN direction ENUM(''HIGHER_BETTER'',''LOWER_BETTER'',''TARGET_RANGE'',''NEUTRAL'',''EXACT'') NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 25b. hrms_role_kpi_assignments.target_json ----------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_role_kpi_assignments' AND COLUMN_NAME = 'target_json');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_role_kpi_assignments ADD COLUMN target_json JSON NULL AFTER target_value', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 25c. hrms_performance_plan_kpis -------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_plan_kpis' AND COLUMN_NAME = 'target_max');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_plan_kpis ADD COLUMN target_max DECIMAL(18,4) NULL AFTER target_number', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_plan_kpis' AND COLUMN_NAME = 'target_date');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_plan_kpis ADD COLUMN target_date DATE NULL AFTER target_max', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_plan_kpis' AND COLUMN_NAME = 'job_target_max');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_plan_kpis ADD COLUMN job_target_max DECIMAL(18,4) NULL AFTER job_target_number', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_plan_kpis' AND COLUMN_NAME = 'job_target_date');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_plan_kpis ADD COLUMN job_target_date DATE NULL AFTER job_target_max', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 25d. hrms_performance_target_changes --------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_target_changes' AND COLUMN_NAME = 'from_max');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_target_changes ADD COLUMN from_max DECIMAL(18,4) NULL AFTER from_number', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_target_changes' AND COLUMN_NAME = 'from_date');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_target_changes ADD COLUMN from_date DATE NULL AFTER from_max', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_target_changes' AND COLUMN_NAME = 'to_max');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_target_changes ADD COLUMN to_max DECIMAL(18,4) NULL AFTER to_number', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_performance_target_changes' AND COLUMN_NAME = 'to_date');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_performance_target_changes ADD COLUMN to_date DATE NULL AFTER to_max', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 26. PAYROLL (CF_HRMS_HIRING_SPEC.md §25.2 — P1 payroll core)             ##
-- ############################################################################
-- Added 2026-10-19. Twelve tables (hrms_pay_payments and three columns added 2026-10-20: 26h).
--
--   hrms_pay_components           the company's list: Basic, HRA, PF (employee) … what each is
--   hrms_pay_structures           templates that split a CTC by formulas ("Staff standard")
--   hrms_pay_structure_lines      one line per component of a structure, with its formula
--   hrms_pay_salaries             a person's salary, DATED: CTC + structure + overrides
--   hrms_pay_statutory_settings   PF / ESI / PT / LWF rates and slabs, DATED, by state, with their source
--   hrms_pay_settings             one row per company: its state, the bank file's debit account
--   hrms_pay_runs                 one payroll per month: DRAFT → CALCULATED → LOCKED → RELEASED → PAID
--   hrms_pay_run_people           a person in a run: days, LOP, totals, warnings, TDS of the month
--   hrms_pay_run_lines            a person × component in a run (and arrears per earlier month)
--   hrms_pay_items                one-time additions / deductions of a person in a run
--   hrms_pay_payslips             a released payslip: the snapshot it prints, never recomputed
--   hrms_pay_payments             what was paid, per person per run (and what a re-open recovers)
--
-- EVERY AMOUNT IS DECIMAL(14,2). EVERY WRITE IS AUDITED (hrms_audit_log, same transaction).
-- NOTHING IS HARD-DELETED: rows are ended (effective_to), soft-deleted (deleted_at) or, for a
-- run's lines, replaced by a new calculation only while the run is not locked — a locked run's
-- rows are never written again except by the Owner's re-open, which is audited with its reason.
--
-- A SALARY IS NEVER OVERWRITTEN. A revision ends the row before it (effective_to = the day
-- before) and adds a new one; a back-dated revision is paid as arrears in the next run.
--
-- Bank account and PAN are the person's identifiers (hrms_employee_identifiers: BANK_ACCOUNT,
-- IFSC, PAN), not columns here: one place, masked on read like the rest.
-- apps/cf_hrms/scripts/apply-payroll-schema.mjs creates exactly these tables (it reads them
-- from this section).

-- ----- 26a. Components --------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_pay_components (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  code              VARCHAR(30)   NOT NULL,                -- BASIC, HRA … what a formula names
  name              VARCHAR(120)  NOT NULL,
  kind              ENUM('EARNING','DEDUCTION','EMPLOYER_CONTRIBUTION','REIMBURSEMENT') NOT NULL,
  taxable           ENUM('YES','PARTLY','NO') NOT NULL DEFAULT 'YES',
  exemption_rule    VARCHAR(40)   NULL,                    -- HRA, LTA, CONVEYANCE … the tax engine (P2) reads it
  in_pf_wage        TINYINT(1)    NOT NULL DEFAULT 0,
  in_esi_wage       TINYINT(1)    NOT NULL DEFAULT 0,
  in_gratuity_wage  TINYINT(1)    NOT NULL DEFAULT 0,
  frequency         ENUM('MONTHLY','YEARLY') NOT NULL DEFAULT 'MONTHLY',
  prorate_on_lop    TINYINT(1)    NOT NULL DEFAULT 1,
  statutory_key     VARCHAR(20)   NULL,                    -- PF_EE, PF_ER, ESI_EE, ESI_ER, PT, LWF_EE, LWF_ER, TDS, ARREARS: worked out by the run
  sort_order        INT           NOT NULL DEFAULT 0,
  status            ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  is_ready_made     TINYINT(1)    NOT NULL DEFAULT 0,
  description       VARCHAR(500)  NULL,

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  code_active       VARCHAR(30)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, UPPER(code), NULL)) VIRTUAL,
  key_active        VARCHAR(20)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, statutory_key, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpcm_tenant (company_id, id),
  UNIQUE KEY uq_hpcm_code   (company_id, code_active),
  UNIQUE KEY uq_hpcm_key    (company_id, key_active),
  CONSTRAINT fk_hpcm_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpcm_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26b. Structures and their lines ------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_pay_structures (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  company_id   INT           NOT NULL,
  code         VARCHAR(30)   NOT NULL,
  name         VARCHAR(120)  NOT NULL,
  description  VARCHAR(500)  NULL,
  status       ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',

  deleted_at   DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT           NULL,

  code_active  VARCHAR(30)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, UPPER(code), NULL)) VIRTUAL,

  UNIQUE KEY uq_hpst_tenant (company_id, id),
  UNIQUE KEY uq_hpst_code   (company_id, code_active),
  CONSTRAINT fk_hpst_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpst_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_structure_lines (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  structure_id  INT           NOT NULL,
  component_id  INT           NOT NULL,
  formula       VARCHAR(300)  NOT NULL,                   -- services/payroll/formula.js; "balance" = what is left of CTC
  sort_order    INT           NOT NULL DEFAULT 0,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  line_active   INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, component_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpsl_tenant (company_id, id),
  UNIQUE KEY uq_hpsl_line   (company_id, structure_id, line_active),
  KEY idx_hpsl_structure (company_id, structure_id),
  CONSTRAINT fk_hpsl_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpsl_structure FOREIGN KEY (company_id, structure_id) REFERENCES hrms_pay_structures(company_id, id),
  CONSTRAINT fk_hpsl_component FOREIGN KEY (company_id, component_id) REFERENCES hrms_pay_components(company_id, id),
  CONSTRAINT fk_hpsl_creator   FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26c. A person's salary, dated --------------------------------------------
-- overrides_json: [{ "componentId": 12, "amount": 2500 }] — a monthly amount that replaces that
-- line's formula for this person (the other lines, and the balance, follow it).
-- pf_mode: CEILING (PF on the wage up to the ceiling — the default) · FULL (on the whole PF wage,
-- by choice) · NONE (not a PF member: an excluded employee). state_code: whose professional tax
-- and LWF apply; NULL = the company's state (hrms_pay_settings).
CREATE TABLE IF NOT EXISTS hrms_pay_salaries (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  employee_id     INT            NOT NULL,
  effective_from  DATE           NOT NULL,
  effective_to    DATE           NULL,
  annual_ctc      DECIMAL(14,2)  NOT NULL,
  structure_id    INT            NOT NULL,
  overrides_json  JSON           NULL,
  pf_mode         ENUM('CEILING','FULL','NONE') NOT NULL DEFAULT 'CEILING',
  state_code      VARCHAR(10)    NULL,
  reason          VARCHAR(500)   NULL,                    -- "Annual revision", "Joining" …

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  UNIQUE KEY uq_hpsa_tenant (company_id, id),
  KEY idx_hpsa_employee (company_id, employee_id, effective_from),
  KEY idx_hpsa_structure (company_id, structure_id),
  CONSTRAINT fk_hpsa_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpsa_employee  FOREIGN KEY (company_id, employee_id)  REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpsa_structure FOREIGN KEY (company_id, structure_id) REFERENCES hrms_pay_structures(company_id, id),
  CONSTRAINT fk_hpsa_creator   FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26d. Statutory settings, dated, by state ----------------------------------
-- kind PF and ESI are national (state_code 'IN'); PT and LWF are by state ('TG' = Telangana).
-- settings_json holds the rates, ceilings and slabs (services/payroll/statutory.js says the
-- shape of each kind). source / source_url: where each value was read; verification
-- VERIFIED (read on the official page) or UNVERIFIED (seeded, to be checked). A change in the
-- law is a NEW row from its date; the old row stays for the months before it.
CREATE TABLE IF NOT EXISTS hrms_pay_statutory_settings (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  kind            ENUM('PF','ESI','PT','LWF') NOT NULL,
  state_code      VARCHAR(10)   NOT NULL DEFAULT 'IN',
  effective_from  DATE          NOT NULL,
  settings_json   JSON          NOT NULL,
  source          TEXT          NULL,
  source_url      VARCHAR(500)  NULL,
  verification    ENUM('VERIFIED','UNVERIFIED') NOT NULL DEFAULT 'UNVERIFIED',
  note            VARCHAR(500)  NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  from_active     DATE          GENERATED ALWAYS AS (IF(deleted_at IS NULL, effective_from, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpss_tenant (company_id, id),
  UNIQUE KEY uq_hpss_day    (company_id, kind, state_code, from_active),
  CONSTRAINT fk_hpss_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpss_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_settings (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  state_code          VARCHAR(10)   NOT NULL DEFAULT 'TG',
  debit_account_no    VARCHAR(40)   NULL,                 -- the company's account the bank file pays from
  debit_ifsc          VARCHAR(20)   NULL,
  narration           VARCHAR(60)   NULL,                 -- "Salary" — the bank file's remark, with the month

  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT           NULL,

  UNIQUE KEY uq_hpse_tenant  (company_id, id),
  UNIQUE KEY uq_hpse_company (company_id),
  CONSTRAINT fk_hpse_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpse_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26e. Runs -------------------------------------------------------------------
-- One live run per company and month. reopen_note: the Owner's reason, each time (also in the audit).
CREATE TABLE IF NOT EXISTS hrms_pay_runs (
  id               INT            AUTO_INCREMENT PRIMARY KEY,
  company_id       INT            NOT NULL,
  period_month     CHAR(7)        NOT NULL,              -- 'YYYY-MM'
  status           ENUM('DRAFT','CALCULATED','LOCKED','RELEASED','PAID') NOT NULL DEFAULT 'DRAFT',
  note             VARCHAR(500)   NULL,
  people_count     INT            NOT NULL DEFAULT 0,
  gross_total      DECIMAL(14,2)  NOT NULL DEFAULT 0,
  deductions_total DECIMAL(14,2)  NOT NULL DEFAULT 0,
  employer_total   DECIMAL(14,2)  NOT NULL DEFAULT 0,
  net_total        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  totals_json      JSON           NULL,                  -- PF admin / EDLI, challan totals, warnings by kind
  calculated_at    DATETIME       NULL,
  calculated_by    INT            NULL,
  locked_at        DATETIME       NULL,
  locked_by        INT            NULL,
  released_at      DATETIME       NULL,
  released_by      INT            NULL,
  paid_at          DATETIME       NULL,
  paid_by          INT            NULL,
  paid_note        VARCHAR(500)   NULL,
  reopen_count     INT            NOT NULL DEFAULT 0,
  reopen_note      VARCHAR(500)   NULL,
  ever_paid        TINYINT(1)     NOT NULL DEFAULT 0,    -- 1 once marked PAID, kept through a re-open (then only the Owner removes the run)

  deleted_at       DATETIME       DEFAULT NULL,
  created_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT            NULL,

  month_active     CHAR(7)        GENERATED ALWAYS AS (IF(deleted_at IS NULL, period_month, NULL)) VIRTUAL,

  UNIQUE KEY uq_hprn_tenant (company_id, id),
  UNIQUE KEY uq_hprn_month  (company_id, month_active),
  KEY idx_hprn_status (company_id, status),
  CONSTRAINT fk_hprn_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hprn_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A person in a run. Rows of a run are replaced by each calculation while the run is DRAFT or
-- CALCULATED (the old rows soft-deleted); calc_json keeps what the calculation used — the LOP
-- days and the salary rows ({ lopDates, salaryIds }) — so a later back-dated revision is found, and
-- its arrears recompute this month on the same days. tds_amount: the month's TDS (P1: typed
-- by HR; P2's tax engine fills it — tds_source).
CREATE TABLE IF NOT EXISTS hrms_pay_run_people (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  run_id            INT            NOT NULL,
  employee_id       INT            NOT NULL,
  salary_id         INT            NULL,                  -- the salary on the last paid day
  structure_id      INT            NULL,
  annual_ctc        DECIMAL(14,2)  NULL,
  days_in_month     INT            NOT NULL,
  employed_days     DECIMAL(6,2)   NOT NULL DEFAULT 0,
  lop_days          DECIMAL(6,2)   NOT NULL DEFAULT 0,
  payable_days      DECIMAL(6,2)   NOT NULL DEFAULT 0,
  calc_json         JSON           NULL,
  gross             DECIMAL(14,2)  NOT NULL DEFAULT 0,
  reimbursements    DECIMAL(14,2)  NOT NULL DEFAULT 0,
  deductions        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  employer_total    DECIMAL(14,2)  NOT NULL DEFAULT 0,
  net_pay           DECIMAL(14,2)  NOT NULL DEFAULT 0,
  pf_wage           DECIMAL(14,2)  NOT NULL DEFAULT 0,
  esi_wage          DECIMAL(14,2)  NOT NULL DEFAULT 0,
  esi_covered       TINYINT(1)     NOT NULL DEFAULT 0,
  tds_amount        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  tds_source        ENUM('MANUAL','ENGINE') NOT NULL DEFAULT 'MANUAL',
  included          TINYINT(1)     NOT NULL DEFAULT 1,    -- 0: in the run only to show why it is not paid (no salary …)
  warnings_json     JSON           NULL,                  -- [{ code, text }]
  bank_json         JSON           NULL,                  -- { account, ifsc } as of the calculation, for the bank file

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  person_active     INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hprp_tenant (company_id, id),
  UNIQUE KEY uq_hprp_person (company_id, run_id, person_active),
  KEY idx_hprp_employee (company_id, employee_id),
  CONSTRAINT fk_hprp_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hprp_run      FOREIGN KEY (company_id, run_id)      REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hprp_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hprp_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- for_month: set on an ARREARS line (the earlier month it pays the difference for).
CREATE TABLE IF NOT EXISTS hrms_pay_run_lines (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  run_id          INT            NOT NULL,
  run_person_id   INT            NOT NULL,
  employee_id     INT            NOT NULL,
  component_id    INT            NOT NULL,
  kind            ENUM('EARNING','DEDUCTION','EMPLOYER_CONTRIBUTION','REIMBURSEMENT') NOT NULL,
  amount          DECIMAL(14,2)  NOT NULL DEFAULT 0,
  full_amount     DECIMAL(14,2)  NULL,                    -- the monthly amount before proration
  basis           VARCHAR(300)   NULL,                    -- how it was worked out, in words
  source          ENUM('STRUCTURE','STATUTORY','ONE_TIME','ARREARS','TDS') NOT NULL DEFAULT 'STRUCTURE',
  for_month       CHAR(7)        NULL,
  pf_wage         DECIMAL(14,2)  NULL,                    -- ARREARS: the PF wage of the difference (a later revision counts it as paid)
  esi_wage        DECIMAL(14,2)  NULL,                    -- ARREARS: the ESI wage of the difference
  sort_order      INT            NOT NULL DEFAULT 0,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  UNIQUE KEY uq_hprl_tenant (company_id, id),
  KEY idx_hprl_person (company_id, run_person_id),
  KEY idx_hprl_run    (company_id, run_id),
  KEY idx_hprl_employee (company_id, employee_id, for_month),
  CONSTRAINT fk_hprl_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hprl_run       FOREIGN KEY (company_id, run_id)        REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hprl_person    FOREIGN KEY (company_id, run_person_id) REFERENCES hrms_pay_run_people(company_id, id),
  CONSTRAINT fk_hprl_component FOREIGN KEY (company_id, component_id)  REFERENCES hrms_pay_components(company_id, id),
  CONSTRAINT fk_hprl_creator   FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26f. One-time items --------------------------------------------------------
CREATE TABLE IF NOT EXISTS hrms_pay_items (
  id             INT            AUTO_INCREMENT PRIMARY KEY,
  company_id     INT            NOT NULL,
  run_id         INT            NOT NULL,
  employee_id    INT            NOT NULL,
  component_id   INT            NOT NULL,
  amount         DECIMAL(14,2)  NOT NULL,
  note           VARCHAR(300)   NULL,

  deleted_at     DATETIME       DEFAULT NULL,
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT            NULL,

  UNIQUE KEY uq_hpit_tenant (company_id, id),
  KEY idx_hpit_run (company_id, run_id, employee_id),
  CONSTRAINT fk_hpit_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpit_run       FOREIGN KEY (company_id, run_id)       REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hpit_employee  FOREIGN KEY (company_id, employee_id)  REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpit_component FOREIGN KEY (company_id, component_id) REFERENCES hrms_pay_components(company_id, id),
  CONSTRAINT fk_hpit_creator   FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26g. Payslips -------------------------------------------------------------
-- Written on release, from the run: snapshot_json is everything the payslip prints (the PDF is
-- drawn from it, never from today's data). A re-open withdraws them (status WITHDRAWN); the next
-- release writes new ones (version + 1).
CREATE TABLE IF NOT EXISTS hrms_pay_payslips (
  id             INT            AUTO_INCREMENT PRIMARY KEY,
  company_id     INT            NOT NULL,
  run_id         INT            NOT NULL,
  run_person_id  INT            NOT NULL,
  employee_id    INT            NOT NULL,
  period_month   CHAR(7)        NOT NULL,
  version        INT            NOT NULL DEFAULT 1,
  status         ENUM('RELEASED','WITHDRAWN') NOT NULL DEFAULT 'RELEASED',
  net_pay        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  snapshot_json  JSON           NOT NULL,
  released_at    DATETIME       NULL,
  released_by    INT            NULL,

  deleted_at     DATETIME       DEFAULT NULL,
  created_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by     INT            NULL,

  UNIQUE KEY uq_hpps_tenant (company_id, id),
  KEY idx_hpps_employee (company_id, employee_id, period_month),
  KEY idx_hpps_run      (company_id, run_id),
  CONSTRAINT fk_hpps_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpps_run      FOREIGN KEY (company_id, run_id)        REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hpps_person   FOREIGN KEY (company_id, run_person_id) REFERENCES hrms_pay_run_people(company_id, id),
  CONSTRAINT fk_hpps_employee FOREIGN KEY (company_id, employee_id)   REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpps_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 26h. What was paid (added 2026-10-20) ---------------------------------------
-- Written when a run is marked PAID: one PAID row per person paid, the amount the bank file
-- carried (the full net the first time; after a re-open, the difference). period_month keeps it
-- with the month, so a month removed and made again still knows what was paid. A person paid
-- MORE than the corrected net is not in the bank file: a RECOVERY row says how much, and a
-- one-time deduction in the next open run recovers it (recovery_run_id, recovery_item_id).
-- Paid so far, for a person and a month = SUM(PAID) − SUM(RECOVERY).
CREATE TABLE IF NOT EXISTS hrms_pay_payments (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  run_id            INT            NOT NULL,
  period_month      CHAR(7)        NOT NULL,
  employee_id       INT            NOT NULL,
  kind              ENUM('PAID','RECOVERY') NOT NULL DEFAULT 'PAID',
  amount            DECIMAL(14,2)  NOT NULL,
  net_pay           DECIMAL(14,2)  NOT NULL DEFAULT 0,    -- the person's net in the run when this was written
  paid_on           DATE           NOT NULL,
  recovery_run_id   INT            NULL,
  recovery_item_id  INT            NULL,
  note              VARCHAR(300)   NULL,

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  UNIQUE KEY uq_hppy_tenant (company_id, id),
  KEY idx_hppy_month    (company_id, period_month, employee_id),
  KEY idx_hppy_run      (company_id, run_id),
  KEY idx_hppy_recovery (company_id, kind, recovery_item_id),
  CONSTRAINT fk_hppy_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hppy_run      FOREIGN KEY (company_id, run_id)      REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hppy_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hppy_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The 2026-10-20 columns, on a database made before them (apply-payroll-schema.mjs does the same).
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_runs' AND COLUMN_NAME = 'ever_paid');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_pay_runs ADD COLUMN ever_paid TINYINT(1) NOT NULL DEFAULT 0 AFTER reopen_note', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_run_lines' AND COLUMN_NAME = 'pf_wage');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_pay_run_lines ADD COLUMN pf_wage DECIMAL(14,2) NULL AFTER for_month, ADD COLUMN esi_wage DECIMAL(14,2) NULL AFTER pf_wage', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 28. ATTENDANCE (CF_HRMS_HIRING_SPEC.md §28)                              ##
-- ############################################################################
-- Added 2026-10-19. Punches in (devices, the REST API, Excel/CSV, the web punch) ->
-- days (hrms_attendance_records, §7c, extended below) -> rules and penalties -> the
-- month a payroll reads. The code is apps/cf_hrms/services/attendance/.
--
--   hrms_attendance_devices          a biometric / face device, or a reader that pushes. The
--                                    SERIAL NUMBER is unique across ALL companies: the ADMS
--                                    "iclock" push knows a company only by the serial a device
--                                    sends, so one serial can never belong to two tenants.
--   hrms_attendance_device_users     enrol number on a device <-> employee. device_id NULL = the
--                                    same number on every device of the company (the usual case).
--   hrms_attendance_punches          RAW, NEVER EDITED. One row per (device, device user, time).
--                                    punched_at is the WALL-CLOCK time where the punch happened
--                                    (`timezone` says which), stored as DATETIME: shift windows are
--                                    wall-clock too. employee_id is NULL until a mapping exists
--                                    (the unmapped queue); adding the mapping attaches them.
--   hrms_attendance_api_keys         per-company keys for POST /api/integrations/attendance/punches.
--                                    Only a SHA-256 of the key is kept; the key is shown once.
--   hrms_attendance_settings         one row per company: "attendance is live from" (nothing is
--                                    processed, and leave keeps its attendance notes, before it),
--                                    the web punch, its IP allow-list and geofences.
--   hrms_attendance_policies         rules as JSON (rules_json), each with a sentence (policy.js).
--   hrms_attendance_policy_assignments  COMPANY / LOCATION / ROLE / LABEL, resolved exactly like
--                                    leave (role -> label -> location -> company).
--   hrms_attendance_penalties        a consequence of a rule (late marks): APPLIED / WAIVED /
--                                    REVERSED. `source_key` makes re-processing idempotent. A
--                                    leave deduction is a SYSTEM leave request (§22, raised_by_system).
--   hrms_attendance_months           OPEN / CLOSED per company and month; a closed month keeps the
--                                    summary payroll reads (summary_json) and is never re-processed.
--   hrms_attendance_runs             one row per processing run; the NIGHTLY row for a date is the
--                                    claim that makes the nightly job safe on a restart.
--
-- Extended (guarded ALTERs below, one change per ALTER):
--   hrms_attendance_records          + source REGULARIZATION, the computed minutes, the day's
--                                    fractions (present / leave / absent), the leave request, why.
--   hrms_attendance_regularizations  + kind (CORRECTION / SHORT_PERMISSION / ON_DUTY), the person
--                                    and date, permission minutes, approver, decision.
--   hrms_leave_requests              + raised_by_system (a penalty's leave deduction).
--   hrms_leave_policy_rules          + min_present_days_for_credit (MONTHLY credit needs N present
--                                    days in the month, once attendance is live).
--
-- apps/cf_hrms/scripts/apply-attendance-schema.mjs makes exactly these changes (it reads the
-- CREATE statements from this section).

CREATE TABLE IF NOT EXISTS hrms_attendance_devices (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  name             VARCHAR(120) NOT NULL,
  serial_number    VARCHAR(64)  NOT NULL,
  make             VARCHAR(60)  NULL,              -- ZKTeco / eSSL / Matrix / …
  model            VARCHAR(60)  NULL,
  location_id      INT          NULL,
  timezone         VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
  protocol         VARCHAR(20)  NOT NULL DEFAULT 'ADMS',   -- ADMS | API | IMPORT
  status           VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DISABLED
  last_seen_at     DATETIME     NULL,              -- UTC
  last_punch_at    DATETIME     NULL,              -- wall-clock of the newest punch it sent
  last_ip          VARCHAR(64)  NULL,
  allowed_ips_json JSON         NULL,              -- ["203.0.113.0/24", "198.51.100.7"]; empty/NULL = any address (28f)
  attlog_stamp     VARCHAR(40)  NULL,              -- the ADMS cursor the device last sent; only ever moves forward
  operlog_stamp    VARCHAR(40)  NULL,
  device_info      VARCHAR(500) NULL,              -- what the device said about itself (INFO=…)
  notes            VARCHAR(500) NULL,

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  serial_active    VARCHAR(64)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, UPPER(serial_number), NULL)) VIRTUAL,

  UNIQUE KEY uq_hadv_tenant (company_id, id),
  UNIQUE KEY uq_hadv_serial (serial_active),
  KEY idx_hadv_company (company_id, status),

  CONSTRAINT fk_hadv_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hadv_location FOREIGN KEY (company_id, location_id) REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hadv_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_device_users (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  device_id        INT          NULL,              -- NULL = every device of the company
  device_user_id   VARCHAR(40)  NOT NULL,          -- the enrol number / PIN
  employee_id      INT          NOT NULL,

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  map_key          VARCHAR(60)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, CONCAT(IFNULL(device_id, 0), ':', device_user_id), NULL)) VIRTUAL,

  UNIQUE KEY uq_hadu_tenant (company_id, id),
  UNIQUE KEY uq_hadu_map    (company_id, map_key),
  KEY idx_hadu_employee (company_id, employee_id),

  CONSTRAINT fk_hadu_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hadu_device   FOREIGN KEY (company_id, device_id)   REFERENCES hrms_attendance_devices(company_id, id),
  CONSTRAINT fk_hadu_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hadu_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_punches (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  employee_id      INT          NULL,              -- NULL = waiting for a mapping
  device_id        INT          NULL,              -- NULL = the REST API / a file / the web, without a device
  device_user_id   VARCHAR(40)  NOT NULL,          -- the enrol number; for a punch without a device, the employee code
  punched_at       DATETIME     NOT NULL,          -- WALL-CLOCK in `timezone`
  timezone         VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
  direction        VARCHAR(10)  NOT NULL DEFAULT 'UNKNOWN', -- IN | OUT | UNKNOWN
  method           VARCHAR(12)  NOT NULL DEFAULT 'OTHER',   -- FINGER | FACE | CARD | PASSWORD | PALM | WEB | MOBILE | IMPORT | API | OTHER
  source           VARCHAR(12)  NOT NULL,                   -- ADMS | API | IMPORT | WEB
  raw_line         VARCHAR(500) NULL,
  batch_id         VARCHAR(40)  NULL,
  latitude         DECIMAL(10,7) NULL,
  longitude        DECIMAL(10,7) NULL,
  ip               VARCHAR(64)  NULL,
  received_at      DATETIME     NOT NULL,          -- UTC
  created_by       INT          NULL,
  deleted_at       DATETIME     DEFAULT NULL,      -- never written: a punch is raw (the file's convention)

  device_key       INT          GENERATED ALWAYS AS (IFNULL(device_id, 0)) VIRTUAL,

  UNIQUE KEY uq_hapn_tenant (company_id, id),
  UNIQUE KEY uq_hapn_punch  (company_id, device_key, device_user_id, punched_at),
  KEY idx_hapn_employee (company_id, employee_id, punched_at),
  KEY idx_hapn_unmapped (company_id, employee_id, device_id, device_user_id),
  KEY idx_hapn_batch    (company_id, batch_id),
  KEY idx_hapn_device_received (company_id, device_id, received_at),   -- the Devices list's "punches today" (28f)

  CONSTRAINT fk_hapn_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hapn_device   FOREIGN KEY (company_id, device_id)   REFERENCES hrms_attendance_devices(company_id, id),
  CONSTRAINT fk_hapn_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hapn_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_api_keys (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  name             VARCHAR(120) NOT NULL,
  key_prefix       VARCHAR(16)  NOT NULL,          -- shown in lists; finds the row
  key_hash         CHAR(64)     NOT NULL,          -- SHA-256 hex of the whole key; the key itself is never stored
  status           VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | REVOKED
  last_used_at     DATETIME     NULL,
  use_count        INT          NOT NULL DEFAULT 0,
  revoked_at       DATETIME     NULL,
  revoked_by       INT          NULL,

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  UNIQUE KEY uq_hakey_tenant (company_id, id),
  UNIQUE KEY uq_hakey_prefix (key_prefix),

  CONSTRAINT fk_hakey_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hakey_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_hakey_revoker FOREIGN KEY (revoked_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_settings (
  id                 INT          AUTO_INCREMENT PRIMARY KEY,
  company_id         INT          NOT NULL,
  live_from          DATE         NULL,            -- NULL = attendance is not live
  web_punch_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  ip_allow_json      JSON         NULL,            -- ["203.0.113.0/24", "198.51.100.7"]; empty = any address
  geofences_json     JSON         NULL,            -- [{ "locationId": 3, "lat": 17.4, "lng": 78.5, "radiusM": 200 }]
  default_timezone   VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',

  deleted_at         DATETIME     DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT          NULL,

  UNIQUE KEY uq_haset_company (company_id),
  CONSTRAINT fk_haset_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_haset_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_policies (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  code             VARCHAR(50)  NULL,
  name             VARCHAR(150) NOT NULL,
  description      VARCHAR(1000) NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',  -- DRAFT | ACTIVE | ARCHIVED
  rules_json       JSON         NOT NULL,

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  name_active      VARCHAR(150) GENERATED ALWAYS AS (IF(deleted_at IS NULL, LOWER(name), NULL)) VIRTUAL,

  UNIQUE KEY uq_hapol_tenant (company_id, id),
  UNIQUE KEY uq_hapol_name   (company_id, name_active),
  CONSTRAINT fk_hapol_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hapol_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_policy_assignments (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  company_id   INT          NOT NULL,
  scope        VARCHAR(20)  NOT NULL,                 -- COMPANY | LOCATION | ROLE | LABEL
  location_id  INT          NULL,
  role_id      INT          NULL,
  label_id     INT          NULL,
  policy_id    INT          NOT NULL,

  deleted_at   DATETIME     DEFAULT NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by   INT          NULL,

  target_key   VARCHAR(40)  GENERATED ALWAYS AS (
                 IF(deleted_at IS NULL, CONCAT(scope, ':', IFNULL(location_id, IFNULL(role_id, IFNULL(label_id, 0)))), NULL)) VIRTUAL,

  UNIQUE KEY uq_hapa_tenant (company_id, id),
  UNIQUE KEY uq_hapa_target (company_id, target_key),
  KEY idx_hapa_policy (company_id, policy_id),

  CONSTRAINT fk_hapa_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hapa_policy   FOREIGN KEY (company_id, policy_id)   REFERENCES hrms_attendance_policies(company_id, id),
  CONSTRAINT fk_hapa_location FOREIGN KEY (company_id, location_id) REFERENCES hrms_locations(company_id, id),
  CONSTRAINT fk_hapa_role     FOREIGN KEY (company_id, role_id)     REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hapa_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_penalties (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  employee_id      INT           NOT NULL,
  penalty_date     DATE          NOT NULL,         -- the day it is charged on (the Nth late mark)
  period_month     CHAR(7)       NOT NULL,         -- YYYY-MM
  rule_key         VARCHAR(30)   NOT NULL,         -- LATE_MARKS
  source_key       VARCHAR(80)   NOT NULL,         -- LATE_MARKS:2026-10:1 — idempotent re-processing
  policy_id        INT           NULL,
  action           VARCHAR(20)   NOT NULL,         -- LEAVE | LOP | AMOUNT | WARNING
  quantity         DECIMAL(6,2)  NOT NULL DEFAULT 0, -- days (LEAVE, LOP)
  amount           DECIMAL(12,2) NOT NULL DEFAULT 0, -- rupees (AMOUNT)
  leave_type_id    INT           NULL,
  leave_request_id INT           NULL,             -- the SYSTEM leave request of a LEAVE action
  dates_json       JSON          NULL,             -- the dates that caused it
  reason           VARCHAR(500)  NOT NULL,
  status           VARCHAR(20)   NOT NULL DEFAULT 'APPLIED', -- APPLIED | WAIVED | REVERSED
  status_note      VARCHAR(500)  NULL,
  decided_by       INT           NULL,
  decided_at       DATETIME      NULL,

  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT           NULL,

  UNIQUE KEY uq_hapen_tenant (company_id, id),
  UNIQUE KEY uq_hapen_source (company_id, employee_id, source_key),
  KEY idx_hapen_month (company_id, period_month, status),

  CONSTRAINT fk_hapen_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hapen_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hapen_request  FOREIGN KEY (company_id, leave_request_id) REFERENCES hrms_leave_requests(company_id, id),
  CONSTRAINT fk_hapen_decider  FOREIGN KEY (decided_by) REFERENCES users(id),
  CONSTRAINT fk_hapen_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_months (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  period_month     CHAR(7)      NOT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'OPEN',   -- OPEN | CLOSED
  summary_json     JSON         NULL,                       -- attendanceMonth() as it stood at the close
  closed_at        DATETIME     NULL,
  closed_by        INT          NULL,
  reopened_at      DATETIME     NULL,
  reopened_by      INT          NULL,
  reopen_reason    VARCHAR(500) NULL,

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  UNIQUE KEY uq_hamon_tenant (company_id, id),
  UNIQUE KEY uq_hamon_month  (company_id, period_month),
  CONSTRAINT fk_hamon_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hamon_closer  FOREIGN KEY (closed_by) REFERENCES users(id),
  CONSTRAINT fk_hamon_opener  FOREIGN KEY (reopened_by) REFERENCES users(id),
  CONSTRAINT fk_hamon_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_attendance_runs (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  kind             VARCHAR(20)  NOT NULL,          -- NIGHTLY | MANUAL | BATCH | LEAVE | REQUEST
  run_key          VARCHAR(80)  NULL,              -- NIGHTLY:2026-10-18 — one claim per night
  from_date        DATE         NOT NULL,
  to_date          DATE         NOT NULL,
  started_at       DATETIME     NOT NULL,
  finished_at      DATETIME     NULL,
  days_written     INT          NOT NULL DEFAULT 0,
  note             VARCHAR(500) NULL,
  created_by       INT          NULL,
  deleted_at       DATETIME     DEFAULT NULL,

  UNIQUE KEY uq_harun_tenant (company_id, id),
  UNIQUE KEY uq_harun_key    (company_id, run_key),
  KEY idx_harun_started (company_id, started_at),
  CONSTRAINT fk_harun_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_harun_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Added 2026-10-20 (hardening): what a device did that HR should see on the Devices screen —
-- IP_CHANGED (it talked from a new address), IP_REFUSED (an address outside its allow-list,
-- at most one row per device and address an hour). Written by the iclock push; never edited.
CREATE TABLE IF NOT EXISTS hrms_attendance_device_events (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  device_id        INT          NOT NULL,
  kind             VARCHAR(20)  NOT NULL,          -- IP_CHANGED | IP_REFUSED
  ip               VARCHAR(64)  NULL,              -- the address it came from
  previous_ip      VARCHAR(64)  NULL,              -- IP_CHANGED: the address before
  note             VARCHAR(300) NULL,
  occurred_at      DATETIME     NOT NULL,          -- UTC

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_hadev_tenant (company_id, id),
  KEY idx_hadev_device (company_id, device_id, occurred_at),

  CONSTRAINT fk_hadev_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hadev_device  FOREIGN KEY (company_id, device_id) REFERENCES hrms_attendance_devices(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 28a. hrms_attendance_records: what processing computes ------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'source' AND COLUMN_TYPE LIKE '%''REGULARIZATION''%');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records MODIFY COLUMN source ENUM(''BIOMETRIC'',''MANUAL'',''IMPORT'',''SYSTEM'',''REGULARIZATION'') NOT NULL DEFAULT ''MANUAL''', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'worked_minutes');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN worked_minutes INT NULL AFTER out_time', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'late_minutes');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN late_minutes INT NOT NULL DEFAULT 0 AFTER worked_minutes', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'early_minutes');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN early_minutes INT NOT NULL DEFAULT 0 AFTER late_minutes', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'overtime_minutes');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN overtime_minutes INT NOT NULL DEFAULT 0 AFTER early_minutes', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'late_mark');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN late_mark TINYINT(1) NOT NULL DEFAULT 0 AFTER overtime_minutes', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'missing_punch');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN missing_punch TINYINT(1) NOT NULL DEFAULT 0 AFTER late_mark', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'present_value');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN present_value DECIMAL(3,2) NOT NULL DEFAULT 0 AFTER missing_punch', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'leave_value');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN leave_value DECIMAL(3,2) NOT NULL DEFAULT 0 AFTER present_value', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'absent_value');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN absent_value DECIMAL(3,2) NOT NULL DEFAULT 0 AFTER leave_value', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'leave_request_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN leave_request_id INT NULL AFTER absent_value', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'regularization_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN regularization_id INT NULL AFTER leave_request_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'policy_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN policy_id INT NULL AFTER regularization_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'status_reason');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN status_reason VARCHAR(300) NULL AFTER policy_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_records' AND COLUMN_NAME = 'processed_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_records ADD COLUMN processed_at DATETIME NULL AFTER status_reason', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 28b. hrms_attendance_regularizations: kinds, the person and the decision --
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'kind');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT ''CORRECTION'' AFTER attendance_record_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'employee_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN employee_id INT NULL AFTER kind', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'attendance_date');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN attendance_date DATE NULL AFTER employee_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'permission_minutes');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN permission_minutes INT NULL AFTER requested_out_time', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'approver_employee_id');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN approver_employee_id INT NULL AFTER status', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'decided_by');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN decided_by INT NULL AFTER reviewed_at', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'decision_note');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN decision_note TEXT NULL AFTER decided_by', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND COLUMN_NAME = 'raised_by_hr');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD COLUMN raised_by_hr TINYINT(1) NOT NULL DEFAULT 0 AFTER decision_note', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_regularizations' AND INDEX_NAME = 'idx_hreg_person_date');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_regularizations ADD KEY idx_hreg_person_date (company_id, employee_id, attendance_date)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 28c. hrms_leave_requests.raised_by_system ----------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_requests' AND COLUMN_NAME = 'raised_by_system');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_requests ADD COLUMN raised_by_system TINYINT(1) NOT NULL DEFAULT 0 AFTER raised_by_hr', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 28e. deleted_at on the new tables that had none (every hrms_ table has it; never written) --
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_punches' AND COLUMN_NAME = 'deleted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_punches ADD COLUMN deleted_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_settings' AND COLUMN_NAME = 'deleted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_settings ADD COLUMN deleted_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_penalties' AND COLUMN_NAME = 'deleted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_penalties ADD COLUMN deleted_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_months' AND COLUMN_NAME = 'deleted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_months ADD COLUMN deleted_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_runs' AND COLUMN_NAME = 'deleted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_runs ADD COLUMN deleted_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 28d. hrms_leave_policy_rules.min_present_days_for_credit -------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_leave_policy_rules' AND COLUMN_NAME = 'min_present_days_for_credit');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_leave_policy_rules ADD COLUMN min_present_days_for_credit TINYINT NULL AFTER credit_in_arrears', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 28f. 2026-10-20 hardening: a device's allowed addresses, the device-list index --
-- (hrms_attendance_device_events is a CREATE above; punches already keep the sender's address in `ip`.)
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_devices' AND COLUMN_NAME = 'allowed_ips_json');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_devices ADD COLUMN allowed_ips_json JSON NULL AFTER last_ip', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_attendance_punches' AND INDEX_NAME = 'idx_hapn_device_received');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_attendance_punches ADD KEY idx_hapn_device_received (company_id, device_id, received_at)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 27. TAX RULES (CF_HRMS_HIRING_SPEC.md §25.3 — the income tax engine)     ##
-- ############################################################################
-- Added 2026-10-19. GLOBAL, not per company: the law is the same for every tenant.
-- Every rate, slab, limit, threshold and form number of the tax engine
-- (apps/cf_hrms/services/tax/) lives here, by tax year and regime, never in code.
--
--   tax_year     '2025-26' (FY 2025-26 = AY 2026-27, Income-tax Act 1961) or
--                '2026-27' (tax year 2026-27, Income-tax Act 2025) …
--   regime       OLD | NEW (NEW is the default regime; rule 'regime' says so)
--   rule_key     slabs, standard_deduction, rebate, surcharge, cess, ded_80c …, exempt_hra …,
--                professional_tax, forms, rounding, tds_rounding (services/tax/index.js lists them)
--   value_json   the rule (its shape is the engine's; services/tax/ruleData.js is the seed)
--   source_note  the section / notification / page the value was read in
--   source_url   where
--   verified     1 = read in an official or primary text; 0 = not confirmed (check before use)
--
-- Rows are written by apps/cf_hrms/scripts/seed-tax-rules.mjs (idempotent by
-- tax_year + regime + rule_key). apps/cf_hrms/scripts/apply-tax-schema.mjs makes this table.
CREATE TABLE IF NOT EXISTS hrms_tax_rules (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  tax_year     VARCHAR(7)    NOT NULL,
  regime       ENUM('OLD','NEW') NOT NULL,
  rule_key     VARCHAR(64)   NOT NULL,
  value_json   JSON          NOT NULL,
  source_note  VARCHAR(1000) NULL,
  source_url   VARCHAR(500)  NULL,
  verified     TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   DATETIME      NULL,

  UNIQUE KEY uq_htr_rule (tax_year, regime, rule_key),
  KEY idx_htr_year (tax_year, regime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 29. ITR HELPER (CF_HRMS_HIRING_SPEC.md §25.6 — P4, option A)             ##
-- ############################################################################
-- Added 2026-10-20. One DRAFT RETURN per person per tax year: the person's own
-- income-tax return worked out by services/tax/itr.js, which they type or upload
-- on incometax.gov.in THEMSELVES. Nothing is filed or sent anywhere.
--
-- PRIVATE: only the person reads or writes their row — routes/itr.js answers
-- /user/me/itr/* only, the employee comes from the login (never from the
-- request), there is NO HR or Owner route and the table is NOT in
-- resourceDef.json (the generic query API cannot read it). No audit row
-- carries its contents. A person's "Start again" deletes the row outright
-- (no deleted_at: their private figures are not kept after they remove them).
--
--   tax_year        '2025-26' (FY 2025-26 = AY 2026-27, return filed in 2026) …
--   status          DRAFT | FINALISED (snapshot_json then holds the employer part as it was)
--   form / regime   the person's pick (NULL = the suggestion: the form by its rules, the cheaper regime)
--   filing_date     when they mean to file (the interest estimate counts to it)
--   personal_json   residential status, date of birth, ITR-1 conditions (director, unlisted shares …)
--   employer_json   the Form 16 / 130 figures TYPED by the person (the payroll figures are read
--                   live from released payslips, not stored), previous employer
--   income_json     interest, dividends, other income, house properties, capital gains summary
--   deductions_json deductions for the whole year (80C … / s.123 …)
--   taxes_json      advance / self-assessment tax with challan details; other TDS / TCS
--   bank_json       the account for the refund (shown masked on screen)
--
-- apps/cf_hrms/scripts/apply-itr-schema.mjs makes this table (dry run by default).
CREATE TABLE IF NOT EXISTS hrms_itr_returns (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  employee_id     INT           NOT NULL,
  tax_year        VARCHAR(7)    NOT NULL,
  status          ENUM('DRAFT','FINALISED') NOT NULL DEFAULT 'DRAFT',
  form            ENUM('ITR1','ITR2') NULL,
  regime          ENUM('OLD','NEW') NULL,
  filing_date     DATE          NULL,
  personal_json   JSON          NULL,
  employer_json   JSON          NULL,
  income_json     JSON          NULL,
  deductions_json JSON          NULL,
  taxes_json      JSON          NULL,
  bank_json       JSON          NULL,
  snapshot_json   JSON          NULL,
  finalised_at    DATETIME      NULL,
  created_by      INT           NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Always NULL: "Start again" deletes the row outright (privacy). The column is here only so the
  -- suites' "nothing left behind" snapshot, which reads deleted_at on every hrms_ table, can count it.
  deleted_at      DATETIME      DEFAULT NULL,

  UNIQUE KEY uq_hitr_person_year (company_id, employee_id, tax_year),
  KEY idx_hitr_employee (company_id, employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 30. TAX IN PAYROLL (CF_HRMS_HIRING_SPEC.md §25.4 — P2 income tax)       ##
-- ############################################################################
-- Added 2026-10-20. Income tax in the monthly payroll: who is in which regime,
-- what they declared and proved, the month's TDS worked out by the tax engine
-- (services/tax/, rules in §27), the challans the TDS was paid with, the
-- quarterly return's data and Form 16 / 130. All per company; amounts
-- DECIMAL(14,2); soft delete; every write audited (hrms_audit_log, same
-- transaction). services/payrollTax/ is the code; routes/tax.js the routes.
--
--   hrms_tax_company            the deductor: TAN, PAN, address, the person responsible (one row a company)
--   hrms_tax_settings           a company's tax YEAR: the declaration window, the proof window, the
--                               regime cut-off, "Reviewed by our CA for <year>" (the Owner's tick),
--                               Forms 16 / 130 released
--   hrms_tax_profiles           a person's tax YEAR: regime (default NEW), city / metro, the declaration
--                               window re-opened for them by HR, the regime changes after the cut-off
--   hrms_tax_declaration_lines  one claim: rent, LTA, home-loan interest, 80C items … and the previous
--                               employer (Form 12B / 122); its proof status SUBMITTED → VERIFIED / REJECTED
--   hrms_tax_files              a stored file (a proof, Form 16 / 130 Part A or Part B); bytes in the chunks
--   hrms_tax_file_chunks        the bytes, deflated, in pieces of at most 2 MB (a TiDB row is limited to
--                               about 6 MB and a proof may be 10 MB) — documentStorage.js's way, split
--   hrms_tax_tds_overrides      HR's TDS for a person in a run, with the reason — wins over the engine
--   hrms_tax_challans           a TDS deposit: challan serial, BSR code, date, amounts, the month it pays
--   hrms_tax_forms              Form 16 / 130 a person a year: Part B generated (snapshot), Part A matched
--
-- Plus hrms_pay_run_people.tax_json: the engine's working for the person's month (both regimes'
-- totals, the projection lines, warnings) — what the run line's tax-sheet link shows for that run.
-- apps/cf_hrms/scripts/apply-payroll-tax-schema.mjs creates exactly these (dry run by default).

CREATE TABLE IF NOT EXISTS hrms_tax_company (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  tan               VARCHAR(10)   NULL,
  pan               VARCHAR(10)   NULL,
  deductor_name     VARCHAR(200)  NULL,
  branch            VARCHAR(100)  NULL,
  address_json      JSON          NULL,
  responsible_json  JSON          NULL,
  deductor_category VARCHAR(2)    NOT NULL DEFAULT 'K',
  note              VARCHAR(500)  NULL,

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  company_active    INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, company_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_htco_company (company_active),
  CONSTRAINT fk_htco_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htco_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_tax_settings (
  id                  INT           AUTO_INCREMENT PRIMARY KEY,
  company_id          INT           NOT NULL,
  tax_year            VARCHAR(7)    NOT NULL,
  declaration_from    DATE          NOT NULL,
  declaration_to      DATE          NOT NULL,
  proof_from          DATE          NOT NULL,
  proof_to            DATE          NOT NULL,
  regime_cutoff       DATE          NOT NULL,
  ca_reviewed         TINYINT(1)    NOT NULL DEFAULT 0,
  ca_reviewed_at      DATETIME      NULL,
  ca_reviewed_by      INT           NULL,
  ca_note             VARCHAR(500)  NULL,
  forms_released_at   DATETIME      NULL,
  forms_released_by   INT           NULL,

  deleted_at          DATETIME      DEFAULT NULL,
  created_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT           NULL,

  year_active         VARCHAR(7)    GENERATED ALWAYS AS (IF(deleted_at IS NULL, tax_year, NULL)) VIRTUAL,

  UNIQUE KEY uq_htst_year (company_id, year_active),
  CONSTRAINT fk_htst_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htst_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- No row = NEW regime, the city from the location, nothing re-opened. metro NULL = from the city;
-- 0 / 1 = set by HR. changes_after_cutoff: HR's one change after the cut-off.
CREATE TABLE IF NOT EXISTS hrms_tax_profiles (
  id                     INT           AUTO_INCREMENT PRIMARY KEY,
  company_id             INT           NOT NULL,
  employee_id            INT           NOT NULL,
  tax_year               VARCHAR(7)    NOT NULL,
  regime                 ENUM('OLD','NEW') NOT NULL DEFAULT 'NEW',
  regime_set_at          DATETIME      NULL,
  regime_set_by          INT           NULL,
  regime_set_how         ENUM('DEFAULT','SELF','HR') NOT NULL DEFAULT 'DEFAULT',
  changes_after_cutoff   INT           NOT NULL DEFAULT 0,
  city                   VARCHAR(100)  NULL,
  metro                  TINYINT(1)    NULL,
  declaration_open_until DATE          NULL,
  note                   VARCHAR(500)  NULL,

  deleted_at             DATETIME      DEFAULT NULL,
  created_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by             INT           NULL,

  person_active          INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_htpr_tenant (company_id, id),
  UNIQUE KEY uq_htpr_person (company_id, tax_year, person_active),
  CONSTRAINT fk_htpr_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htpr_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_htpr_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One claim. kind: services/payrollTax/declarations.js (KINDS) lists them and what each needs in
-- details_json. status: DECLARED (no proof yet) → SUBMITTED (a proof uploaded) → VERIFIED
-- (accepted_amount, may be lower) | REJECTED (reject_reason; a new proof submits it again).
CREATE TABLE IF NOT EXISTS hrms_tax_declaration_lines (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  employee_id       INT            NOT NULL,
  tax_year          VARCHAR(7)     NOT NULL,
  kind              VARCHAR(40)    NOT NULL,
  declared_amount   DECIMAL(14,2)  NOT NULL DEFAULT 0,
  details_json      JSON           NULL,
  status            ENUM('DECLARED','SUBMITTED','VERIFIED','REJECTED') NOT NULL DEFAULT 'DECLARED',
  accepted_amount   DECIMAL(14,2)  NULL,
  reject_reason     VARCHAR(500)   NULL,
  submitted_at      DATETIME       NULL,
  reviewed_at       DATETIME       NULL,
  reviewed_by       INT            NULL,

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  UNIQUE KEY uq_htdl_tenant (company_id, id),
  KEY idx_htdl_person (company_id, employee_id, tax_year),
  KEY idx_htdl_status (company_id, tax_year, status),
  CONSTRAINT fk_htdl_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htdl_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_htdl_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- purpose PROOF (line_id set), PART_A (Form 16 / 130 Part A from TRACES; employee_id NULL until
-- matched), PART_B (generated here).
CREATE TABLE IF NOT EXISTS hrms_tax_files (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  company_id        INT            NOT NULL,
  purpose           ENUM('PROOF','PART_A','PART_B') NOT NULL,
  tax_year          VARCHAR(7)     NOT NULL,
  employee_id       INT            NULL,
  line_id           INT            NULL,
  file_name         VARCHAR(255)   NOT NULL,
  mime_type         VARCHAR(100)   NOT NULL,
  size_bytes        INT            NOT NULL,
  storage           VARCHAR(16)    NOT NULL DEFAULT 'db',
  compression       VARCHAR(16)    NOT NULL DEFAULT 'deflate',
  chunk_count       INT            NOT NULL DEFAULT 0,
  sha256            CHAR(64)       NULL,
  matched_by        VARCHAR(20)    NULL,
  pan_found         VARCHAR(10)    NULL,

  deleted_at        DATETIME       DEFAULT NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT            NULL,

  UNIQUE KEY uq_htfi_tenant (company_id, id),
  KEY idx_htfi_line (company_id, line_id),
  KEY idx_htfi_person (company_id, tax_year, purpose, employee_id),
  CONSTRAINT fk_htfi_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htfi_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_htfi_line     FOREIGN KEY (company_id, line_id) REFERENCES hrms_tax_declaration_lines(company_id, id),
  CONSTRAINT fk_htfi_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_tax_file_chunks (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  company_id  INT          NOT NULL,
  file_id     INT          NOT NULL,
  seq         INT          NOT NULL,
  content     LONGBLOB     NOT NULL,
  deleted_at  DATETIME     DEFAULT NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_htfc_piece (company_id, file_id, seq),
  CONSTRAINT fk_htfc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htfc_file    FOREIGN KEY (company_id, file_id) REFERENCES hrms_tax_files(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- HR's TDS for a person in a run (an amount, 0 allowed, and why). Wins over the engine; the
-- engine's figure is still worked out and kept beside it (hrms_pay_run_people.tax_json).
CREATE TABLE IF NOT EXISTS hrms_tax_tds_overrides (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  company_id    INT            NOT NULL,
  run_id        INT            NOT NULL,
  employee_id   INT            NOT NULL,
  amount        DECIMAL(14,2)  NOT NULL,
  reason        VARCHAR(500)   NOT NULL,

  deleted_at    DATETIME       DEFAULT NULL,
  created_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT            NULL,

  person_active INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_htto_person (company_id, run_id, person_active),
  CONSTRAINT fk_htto_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htto_run      FOREIGN KEY (company_id, run_id) REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_htto_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_htto_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A TDS deposit. period_month: the month whose TDS it pays. total = tax + surcharge + cess +
-- interest + fee + others.
CREATE TABLE IF NOT EXISTS hrms_tax_challans (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  tax_year        VARCHAR(7)     NOT NULL,
  period_month    CHAR(7)        NOT NULL,
  challan_serial  VARCHAR(10)    NOT NULL,
  bsr_code        VARCHAR(7)     NOT NULL,
  deposit_date    DATE           NOT NULL,
  tax             DECIMAL(14,2)  NOT NULL DEFAULT 0,
  surcharge       DECIMAL(14,2)  NOT NULL DEFAULT 0,
  cess            DECIMAL(14,2)  NOT NULL DEFAULT 0,
  interest        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  fee             DECIMAL(14,2)  NOT NULL DEFAULT 0,
  others          DECIMAL(14,2)  NOT NULL DEFAULT 0,
  total           DECIMAL(14,2)  NOT NULL DEFAULT 0,
  minor_head      VARCHAR(4)     NOT NULL DEFAULT '200',
  note            VARCHAR(500)   NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  UNIQUE KEY uq_htch_tenant (company_id, id),
  KEY idx_htch_month (company_id, period_month),
  KEY idx_htch_year (company_id, tax_year),
  CONSTRAINT fk_htch_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htch_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Form 16 / 130 of a person for a year: Part B generated (its file and the figures it printed,
-- snapshot_json) and Part A matched from TRACES. One live row a person a year.
CREATE TABLE IF NOT EXISTS hrms_tax_forms (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  employee_id     INT           NOT NULL,
  tax_year        VARCHAR(7)    NOT NULL,
  part_b_file_id  INT           NULL,
  part_a_file_id  INT           NULL,
  snapshot_json   JSON          NULL,
  generated_at    DATETIME      NULL,
  generated_by    INT           NULL,
  provisional     TINYINT(1)    NOT NULL DEFAULT 0,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT           NULL,

  person_active   INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_htfm_person (company_id, tax_year, person_active),
  CONSTRAINT fk_htfm_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_htfm_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_htfm_partb    FOREIGN KEY (company_id, part_b_file_id) REFERENCES hrms_tax_files(company_id, id),
  CONSTRAINT fk_htfm_parta    FOREIGN KEY (company_id, part_a_file_id) REFERENCES hrms_tax_files(company_id, id),
  CONSTRAINT fk_htfm_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 30b. hrms_pay_run_people.tax_json (the engine's working for the person's month) -----
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_run_people' AND COLUMN_NAME = 'tax_json');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_pay_run_people ADD COLUMN tax_json JSON NULL AFTER tds_source', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 31. PAYROLL EXTRAS (CF_HRMS_HIRING_SPEC.md §25.5 — P3a)                   ##
-- ############################################################################
-- Added 2026-10-20. The parts of P3 that do not change how a payroll run calculates:
-- the statutory return files (PF ECR, ESI monthly contribution, Telangana PT) are MADE
-- FROM LOCKED RUNS and need no table; the perquisites register and the Form 10E
-- worksheet are kept here. Per company; amounts DECIMAL(14,2); soft delete; every write
-- audited (hrms_audit_log, same transaction). services/payrollExtras/ is the code,
-- services/tax/perquisites.js and services/tax/relief.js the pure arithmetic,
-- routes/payrollExtras.js the routes.
--
--   hrms_pay_perquisites   one perquisite of a person in a tax year: its KIND (car,
--                          accommodation, loan, gift, credit card, club, other) and the FACTS
--                          HR enters (facts_json; the shape per kind is in
--                          services/tax/perquisites.js). The value is never typed: it is
--                          worked out from the facts by the year's rules (hrms_tax_rules key
--                          'perquisites') each time it is read.
--   hrms_tax_relief_10e    a person's Form 10E worksheet for the year arrears were received
--                          (relief u/s 89 / s.157 of the 2025 Act): what was typed for earlier
--                          years that have no rules here (inputs_json) and the worksheet as last
--                          worked out (result_json, what the PDF prints). One live row a person
--                          a year.
-- apps/cf_hrms/scripts/apply-payroll-extras-schema.mjs creates exactly these (dry run by default).

CREATE TABLE IF NOT EXISTS hrms_pay_perquisites (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  employee_id   INT           NOT NULL,
  tax_year      VARCHAR(7)    NOT NULL,                 -- '2026-27'
  kind          ENUM('CAR','ACCOMMODATION','LOAN','GIFT','CREDIT_CARD','CLUB','OTHER') NOT NULL,
  label         VARCHAR(120)  NULL,                     -- "Honda City, TS09 AB 1234", "Flat 4B, Banjara Hills"
  from_date     DATE          NOT NULL,                 -- within the tax year
  to_date       DATE          NULL,                     -- NULL = to the end of the year
  facts_json    JSON          NOT NULL,
  note          VARCHAR(500)  NULL,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  UNIQUE KEY uq_hpqs_tenant (company_id, id),
  KEY idx_hpqs_person (company_id, employee_id, tax_year),
  KEY idx_hpqs_year (company_id, tax_year),
  CONSTRAINT fk_hpqs_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpqs_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpqs_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_tax_relief_10e (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  employee_id     INT            NOT NULL,
  tax_year        VARCHAR(7)     NOT NULL,              -- the year the arrears were RECEIVED
  inputs_json     JSON           NULL,                  -- { earlier: { '2024-25': { regime, totalIncome, taxWithout, taxWith } }, receipt: { totalIncome? } }
  result_json     JSON           NULL,                  -- the Annexure I worksheet as last worked out
  relief          DECIMAL(14,2)  NOT NULL DEFAULT 0,
  status          ENUM('INCOMPLETE','READY') NOT NULL DEFAULT 'INCOMPLETE',  -- INCOMPLETE: an earlier year still needs typed figures
  generated_at    DATETIME       NULL,
  generated_by    INT            NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  person_active   INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_ht10_tenant (company_id, id),
  UNIQUE KEY uq_ht10_person (company_id, tax_year, person_active),
  KEY idx_ht10_employee (company_id, employee_id),
  CONSTRAINT fk_ht10_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_ht10_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_ht10_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 32. PAYROLL EXIT AND CLAIMS (CF_HRMS_HIRING_SPEC.md §25.5 — P3b)          ##
-- ############################################################################
-- Added 2026-10-20. The rest of P3: full and final settlement on leaving (§4), claims with
-- bills (reimbursements and flexible benefits), attendance into the run (§28.6). Per company;
-- amounts DECIMAL(14,2); soft delete; every write audited (hrms_audit_log, same transaction).
-- services/payrollExit/ is the code, routes/payrollExit.js the routes.
--
--   hrms_pay_policy               the company's payroll formulas and choices that are not law:
--                                 the overtime hourly rate, the leave-encashment day rate, the
--                                 notice-pay day rate (formulas in the structure language), what
--                                 happens to an unclaimed flexible balance at the year end, and
--                                 whether a manager looks at a claim before HR. One row a company;
--                                 none = the defaults (services/payrollExit/policy.js).
--   hrms_pay_attendance_overrides HR's "pay without attendance" for one run, with the reason —
--                                 attendance is live but the month is not closed.
--   hrms_pay_settlements          a person's full and final: what was typed (inputs_json), the
--                                 statement as last worked out (result_json), DRAFT -> APPROVED ->
--                                 PAID. It pays in the run of pay_month (run_id once a calculation
--                                 took it). One live settlement a person.
--   hrms_pay_claim_types          the company's claim types: yearly limit, taxable / exempt / LTA
--                                 (with the rule in words), bills needed, flexible (part of pay: an
--                                 unclaimed balance is paid, taxed, at the year end).
--   hrms_pay_claims               a person's claim; SUBMITTED (with the manager) -> RECOMMENDED
--                                 (with HR) -> APPROVED (amount may be lower; pays in the run of
--                                 pay_month) -> PAID; REJECTED, WITHDRAWN.
--   hrms_pay_retirement_facts     what the payroll cannot know for the accretion on employer contributions
--                                 above the year's limit (rule 3B): the excess and accretion of earlier
--                                 years, the fund's rate of income. One live row a person a year.
--   hrms_pay_claim_bills          the bills of a claim: the file is a hrms_tax_files row (purpose
--                                 CLAIM_BILL), its bytes in hrms_tax_file_chunks, as P2's proofs.
-- And three guarded changes to existing columns (appended ENUM values, nothing else changes):
--   hrms_pay_run_lines.source     + 'ATTENDANCE' (overtime, penalty), 'SETTLEMENT', 'CLAIM'
--   hrms_tax_files.purpose        + 'CLAIM_BILL'
-- apps/cf_hrms/scripts/apply-payroll-exit-schema.mjs does exactly these (dry run by default).

CREATE TABLE IF NOT EXISTS hrms_pay_policy (
  id                     INT           AUTO_INCREMENT PRIMARY KEY,
  company_id             INT           NOT NULL,
  overtime_rate_formula  VARCHAR(300)  NULL,                 -- an HOUR of overtime at 1x; NULL = (BASIC + DA) / 26 / 8
  encash_rate_formula    VARCHAR(300)  NULL,                 -- a DAY of leave encashed; NULL = BASIC / 26
  notice_rate_formula    VARCHAR(300)  NULL,                 -- a DAY of notice pay; NULL = GROSS / 30
  flexi_year_end         VARCHAR(20)   NOT NULL DEFAULT 'PAY_TAXABLE',  -- PAY_TAXABLE | LAPSE
  claims_manager_first   TINYINT(1)    NOT NULL DEFAULT 1,   -- a claim goes to the person's manager before HR

  deleted_at             DATETIME      DEFAULT NULL,
  created_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by             INT           NULL,

  live_company           INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, company_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hppo_tenant (company_id, id),
  UNIQUE KEY uq_hppo_company (live_company),
  CONSTRAINT fk_hppo_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hppo_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_attendance_overrides (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  run_id        INT           NOT NULL,
  reason        VARCHAR(500)  NOT NULL,

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  live_run      INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, run_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpao_tenant (company_id, id),
  UNIQUE KEY uq_hpao_run (company_id, live_run),
  CONSTRAINT fk_hpao_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpao_run     FOREIGN KEY (company_id, run_id) REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hpao_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_settlements (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  employee_id     INT            NOT NULL,
  exit_id         INT            NULL,                  -- hrms_employee_exits (the leaving record it settles)
  last_day        DATE           NOT NULL,              -- the last working day it was worked out for
  status          VARCHAR(20)    NOT NULL DEFAULT 'DRAFT',  -- DRAFT | APPROVED | PAID
  pay_month       CHAR(7)        NULL,                  -- the run it pays in (set on approval)
  run_id          INT            NULL,                  -- the run whose calculation took it
  inputs_json     JSON           NULL,                  -- what HR typed: notice days, waivers, bonus, recoveries …
  result_json     JSON           NULL,                  -- the statement as last worked out
  net_amount      DECIMAL(14,2)  NOT NULL DEFAULT 0,    -- what the settlement adds to the last pay (may be below 0)
  approved_at     DATETIME       NULL,
  approved_by     INT            NULL,
  paid_at         DATETIME       NULL,
  note            VARCHAR(1000)  NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  live_employee   INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpfnf_tenant (company_id, id),
  UNIQUE KEY uq_hpfnf_person (company_id, live_employee),
  KEY idx_hpfnf_month (company_id, status, pay_month),
  CONSTRAINT fk_hpfnf_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpfnf_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpfnf_exit     FOREIGN KEY (company_id, exit_id) REFERENCES hrms_employee_exits(company_id, id),
  CONSTRAINT fk_hpfnf_run      FOREIGN KEY (company_id, run_id) REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hpfnf_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_claim_types (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  company_id      INT            NOT NULL,
  code            VARCHAR(30)    NOT NULL,              -- FUEL, PHONE, LTA, MEALS, BOOKS …
  name            VARCHAR(120)   NOT NULL,
  yearly_limit    DECIMAL(14,2)  NULL,                  -- a person's limit in a tax year; NULL = none
  tax_treatment   VARCHAR(20)    NOT NULL DEFAULT 'EXEMPT',  -- EXEMPT | TAXABLE | LTA (the leave-travel rule)
  tax_rule        VARCHAR(500)   NULL,                  -- the rule in words ("rule 3(7)(ix): telephone …")
  bills_needed    TINYINT(1)     NOT NULL DEFAULT 1,
  flexible        TINYINT(1)     NOT NULL DEFAULT 0,    -- part of pay: an unclaimed balance is paid, taxed, at the year end
  status          VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | INACTIVE
  sort_order      INT            NOT NULL DEFAULT 0,
  description     VARCHAR(500)   NULL,

  deleted_at      DATETIME       DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by      INT            NULL,

  live_code       VARCHAR(30)    GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL,

  UNIQUE KEY uq_hpct_tenant (company_id, id),
  UNIQUE KEY uq_hpct_code (company_id, live_code),
  CONSTRAINT fk_hpct_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpct_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_claims (
  id                 INT            AUTO_INCREMENT PRIMARY KEY,
  company_id         INT            NOT NULL,
  employee_id        INT            NOT NULL,
  claim_type_id      INT            NOT NULL,
  tax_year           VARCHAR(7)     NOT NULL,           -- of the bill date
  bill_date          DATE           NOT NULL,
  amount             DECIMAL(14,2)  NOT NULL,           -- claimed
  approved_amount    DECIMAL(14,2)  NULL,               -- HR's (may be lower)
  description        VARCHAR(500)   NULL,
  journeys_json      JSON           NULL,               -- LTA: [{ from, to, startDate, endDate, mode }]
  lta_exempt         TINYINT(1)     NULL,               -- LTA: within the journeys of the block (decided on approval)
  lta_note           VARCHAR(300)   NULL,
  status             VARCHAR(20)    NOT NULL DEFAULT 'SUBMITTED',  -- SUBMITTED | RECOMMENDED | APPROVED | PAID | REJECTED | WITHDRAWN
  approver_employee_id INT          NULL,               -- the manager who looks first (NULL = straight to HR)
  manager_note       VARCHAR(500)   NULL,
  manager_at         DATETIME       NULL,
  manager_by         INT            NULL,
  decision_note      VARCHAR(500)   NULL,
  decided_at         DATETIME       NULL,
  decided_by         INT            NULL,
  pay_month          CHAR(7)        NULL,               -- the run it pays in (set on approval)
  run_id             INT            NULL,               -- the run whose calculation took it
  paid_at            DATETIME       NULL,

  deleted_at         DATETIME       DEFAULT NULL,
  created_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT            NULL,

  UNIQUE KEY uq_hpcl_tenant (company_id, id),
  KEY idx_hpcl_person (company_id, employee_id, tax_year),
  KEY idx_hpcl_status (company_id, status, pay_month),
  CONSTRAINT fk_hpcl_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpcl_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hpcl_type     FOREIGN KEY (company_id, claim_type_id) REFERENCES hrms_pay_claim_types(company_id, id),
  CONSTRAINT fk_hpcl_run      FOREIGN KEY (company_id, run_id) REFERENCES hrms_pay_runs(company_id, id),
  CONSTRAINT fk_hpcl_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_claim_bills (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  company_id    INT           NOT NULL,
  claim_id      INT           NOT NULL,
  file_id       INT           NOT NULL,                 -- hrms_tax_files (purpose CLAIM_BILL)

  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by    INT           NULL,

  UNIQUE KEY uq_hpcb_tenant (company_id, id),
  KEY idx_hpcb_claim (company_id, claim_id),
  CONSTRAINT fk_hpcb_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hpcb_claim   FOREIGN KEY (company_id, claim_id) REFERENCES hrms_pay_claims(company_id, id),
  CONSTRAINT fk_hpcb_file    FOREIGN KEY (company_id, file_id) REFERENCES hrms_tax_files(company_id, id),
  CONSTRAINT fk_hpcb_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_retirement_facts (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  company_id          INT            NOT NULL,
  employee_id         INT            NOT NULL,
  tax_year            VARCHAR(7)     NOT NULL,
  previous_excess     DECIMAL(14,2)  NULL,               -- PC1: excess contributions of the years before, together
  previous_accretion  DECIMAL(14,2)  NULL,               -- TP1: accretion taxed in the years before, together
  rate_pct            DECIMAL(7,4)   NULL,               -- R as a %, or worked from the three below
  fund_income         DECIMAL(14,2)  NULL,               -- I
  fund_opening        DECIMAL(14,2)  NULL,
  fund_closing        DECIMAL(14,2)  NULL,
  note                VARCHAR(500)   NULL,

  deleted_at          DATETIME       DEFAULT NULL,
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by          INT            NULL,

  person_active       INT            GENERATED ALWAYS AS (IF(deleted_at IS NULL, employee_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hprf_tenant (company_id, id),
  UNIQUE KEY uq_hprf_person (company_id, tax_year, person_active),
  CONSTRAINT fk_hprf_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hprf_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id),
  CONSTRAINT fk_hprf_creator  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 32b. Appended ENUM values (guarded: only when the value is missing) -------------
SET @t = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_pay_run_lines' AND COLUMN_NAME = 'source');
SET @sql = IF(@t IS NOT NULL AND @t NOT LIKE '%''CLAIM''%', "ALTER TABLE hrms_pay_run_lines MODIFY COLUMN source ENUM('STRUCTURE','STATUTORY','ONE_TIME','ARREARS','TDS','ATTENDANCE','SETTLEMENT','CLAIM') NOT NULL DEFAULT 'STRUCTURE'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @t = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_tax_files' AND COLUMN_NAME = 'purpose');
SET @sql = IF(@t IS NOT NULL AND @t NOT LIKE '%''CLAIM_BILL''%', "ALTER TABLE hrms_tax_files MODIFY COLUMN purpose ENUM('PROOF','PART_A','PART_B','CLAIM_BILL') NOT NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 35. ORG UNIT EXTRAS (CF_HRMS_HIRING_SPEC.md §34 — colours, order)        ##
-- ############################################################################
-- Added 2026-10-24. Two guarded columns, nothing else:
--   hrms_department_labels.colour   a palette KEY (blue, teal, green, lime, amber, orange, red, pink,
--                                   purple, indigo, cyan, slate — departmentLabelService KIND_COLOURS),
--                                   never a raw hex; NULL = the kind's default colour.
--   hrms_departments.sort_order     the order among siblings (and at the top level). Lists, pickers and the
--                                   org chart order siblings by sort_order, then code — never by name.
-- scripts/apply-org-unit-extras-schema.mjs adds both and fills sort_order from the code order, idempotently.

-- ----- 35a. hrms_department_labels.colour -----------------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_department_labels' AND COLUMN_NAME = 'colour');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_department_labels ADD COLUMN colour VARCHAR(20) NULL AFTER sort_order', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ----- 35b. hrms_departments.sort_order --------------------------------------------------------
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrms_departments' AND COLUMN_NAME = 'sort_order');
SET @sql = IF(@c = 0, 'ALTER TABLE hrms_departments ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER parent_department_id', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ############################################################################
-- ## 38. COMPLIANCE (CF_HRMS_HIRING_SPEC.md §36.4, §36.5)                     ##
-- ############################################################################
-- Added 2026-10-24: the watcher, notices, publishing, notifications, the deadline calendar and the
-- CA review. The LAW itself (rule versions, DRAFT → PUBLISHED) belongs to the law layer (services/law,
-- hrms_law_rules — spec §36.1, its own section). This section holds what is AROUND it:
--
--   GLOBAL (the product team's; no company_id, only deleted_at):
--     platform_admins                 who may open /api/platform/* — the product team, outside any company.
--                                     A user id AND the email it had when granted (both must still match).
--                                     Written only by scripts/grant-platform-admin.mjs; no route writes it.
--     hrms_compliance_sources         the official pages the watcher reads (kind html_list / rss / pdf_index;
--                                     watch_text: the page's visible text is one more item, for a page of
--                                     rates with no links; also_sites: other sites its links may point to, e.g.
--                                     EPFO's PDFs on epfindia.gov.in). The first good read is the baseline: no notices.
--     hrms_compliance_source_items    every link a source has listed (hash of the URL; hash of title + date).
--     hrms_compliance_check_runs      one row per source per slot: the watcher's claim (restart-safe, two instances).
--     hrms_compliance_notices         new or changed items for a reviewer: open → linked → published / dismissed.
--     hrms_compliance_publications    what was published (through the law layer, or the adapter until it exists).
--
--   PER COMPANY (company_id + deleted_at):
--     hrms_compliance_notifications   one per publication (and per due deadline) per company, with its impact;
--                                     acknowledged once; re-sent while it is not.
--     hrms_compliance_emails          the outbox: queued, then sent by the hourly pass (rate-limited), only to
--                                     the company's own Owner / HR logins.
--     hrms_compliance_deadline_marks  a deadline marked done, and the reminders sent for it.
--     hrms_compliance_reviews         the CA's state per rule set: PENDING / APPROVED / QUESTIONED.
--     hrms_compliance_review_comments every comment, approval and question, kept.
--     hrms_compliance_signoffs        the CA's yearly sign-off (it sets hrms_tax_settings.ca_reviewed for the year).
-- scripts/apply-compliance-schema.mjs creates them (guarded, dry run by default) and seeds the sources.

CREATE TABLE IF NOT EXISTS platform_admins (
  id            INT           AUTO_INCREMENT PRIMARY KEY,
  user_id       INT           NOT NULL,
  email         VARCHAR(255)  NOT NULL,
  note          VARCHAR(300)  NULL,
  deleted_at    DATETIME      DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  user_active   INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, user_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_pa_user (user_active),
  CONSTRAINT fk_pa_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_sources (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  code               VARCHAR(40)   NOT NULL,
  name               VARCHAR(200)  NOT NULL,
  url                VARCHAR(500)  NOT NULL,
  kind               ENUM('html_list','rss','pdf_index') NOT NULL,
  frequency_hours    INT           NOT NULL DEFAULT 24,
  domains_json       JSON          NULL,
  jurisdictions_json JSON          NULL,
  link_pattern       VARCHAR(300)  NULL,
  watch_text         TINYINT(1)    NOT NULL DEFAULT 0,
  also_sites         VARCHAR(300)  NULL,
  note               VARCHAR(500)  NULL,
  active             TINYINT(1)    NOT NULL DEFAULT 1,
  last_checked_at    DATETIME      NULL,
  last_ok_at         DATETIME      NULL,
  last_change_at     DATETIME      NULL,
  last_status        ENUM('NEVER','OK','CHANGED','ERROR','BLOCKED') NOT NULL DEFAULT 'NEVER',
  last_error         VARCHAR(500)  NULL,
  fail_count         INT           NOT NULL DEFAULT 0,
  item_count         INT           NOT NULL DEFAULT 0,
  next_check_at      DATETIME      NULL,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  code_active        VARCHAR(40)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, code, NULL)) VIRTUAL,

  UNIQUE KEY uq_hcs_code (code_active),
  KEY idx_hcs_due (active, next_check_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_source_items (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  source_id      INT           NOT NULL,
  item_hash      CHAR(64)      NOT NULL,
  content_hash   CHAR(64)      NOT NULL,
  url            VARCHAR(1000) NOT NULL,
  title          VARCHAR(500)  NOT NULL,
  item_date      DATE          NULL,
  first_seen_at  DATETIME      NOT NULL,
  last_seen_at   DATETIME      NOT NULL,
  changed_at     DATETIME      NULL,
  deleted_at     DATETIME      DEFAULT NULL,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_hcsi_item (source_id, item_hash),
  CONSTRAINT fk_hcsi_source FOREIGN KEY (source_id) REFERENCES hrms_compliance_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_check_runs (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  source_id      INT           NOT NULL,
  run_key        VARCHAR(80)   NOT NULL,
  status         ENUM('RUNNING','DONE','ERROR') NOT NULL DEFAULT 'RUNNING',
  started_at     DATETIME      NOT NULL,
  finished_at    DATETIME      NULL,
  items_seen     INT           NOT NULL DEFAULT 0,
  found_new      INT           NOT NULL DEFAULT 0,
  found_changed  INT           NOT NULL DEFAULT 0,
  http_status    INT           NULL,
  error          VARCHAR(500)  NULL,
  deleted_at     DATETIME      DEFAULT NULL,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_hccr_key (run_key),
  KEY idx_hccr_source (source_id, started_at),
  CONSTRAINT fk_hccr_source FOREIGN KEY (source_id) REFERENCES hrms_compliance_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_notices (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  source_id        INT           NOT NULL,
  item_id          INT           NOT NULL,
  change_kind      ENUM('NEW','CHANGED') NOT NULL DEFAULT 'NEW',
  title            VARCHAR(500)  NOT NULL,
  url              VARCHAR(1000) NOT NULL,
  item_date        DATE          NULL,
  found_at         DATETIME      NOT NULL,
  status           ENUM('NEW','OPEN','LINKED','PUBLISHED','DISMISSED') NOT NULL DEFAULT 'NEW',
  summary          TEXT          NULL,
  domain           VARCHAR(30)   NULL,
  jurisdiction     VARCHAR(10)   NULL,
  rule_key         VARCHAR(64)   NULL,
  rule_version_id  VARCHAR(40)   NULL,
  reviewer_user_id INT           NULL,
  opened_at        DATETIME      NULL,
  linked_at        DATETIME      NULL,
  dismissed_reason VARCHAR(500)  NULL,
  dismissed_at     DATETIME      NULL,
  publication_id   INT           NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_hcn_status (status, found_at),
  CONSTRAINT fk_hcn_source FOREIGN KEY (source_id) REFERENCES hrms_compliance_sources(id),
  CONSTRAINT fk_hcn_item   FOREIGN KEY (item_id)   REFERENCES hrms_compliance_source_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_publications (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  notice_id          INT           NULL,
  domain             VARCHAR(30)   NOT NULL,
  jurisdiction       VARCHAR(10)   NOT NULL DEFAULT 'IN',
  rule_key           VARCHAR(64)   NOT NULL,
  rule_version_id    VARCHAR(40)   NULL,
  version_label      VARCHAR(40)   NULL,
  title              VARCHAR(300)  NOT NULL,
  summary            TEXT          NULL,
  effective_from     DATE          NOT NULL,
  value_json         JSON          NULL,
  source_url         VARCHAR(1000) NULL,
  via                ENUM('LAW_LAYER','ADAPTER') NOT NULL,
  published_by       INT           NULL,
  published_by_name  VARCHAR(150)  NULL,
  published_at       DATETIME      NOT NULL,
  companies_notified INT           NOT NULL DEFAULT 0,
  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_hcp_when (published_at),
  CONSTRAINT fk_hcp_publisher FOREIGN KEY (published_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_notifications (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  kind             ENUM('LAW_CHANGE','DEADLINE') NOT NULL,
  publication_id   INT           NULL,
  deadline_key     VARCHAR(60)   NULL,
  due_date         DATE          NULL,
  title            VARCHAR(300)  NOT NULL,
  body             TEXT          NULL,
  impact_json      JSON          NULL,
  status           ENUM('OPEN','ACKNOWLEDGED') NOT NULL DEFAULT 'OPEN',
  acknowledged_by  INT           NULL,
  acknowledged_at  DATETIME      NULL,
  ack_note         VARCHAR(500)  NULL,
  last_sent_at     DATETIME      NULL,
  send_count       INT           NOT NULL DEFAULT 0,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  pub_active       INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, publication_id, NULL)) VIRTUAL,
  deadline_active  VARCHAR(60)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, deadline_key, NULL)) VIRTUAL,

  UNIQUE KEY uq_hcno_tenant (company_id, id),
  UNIQUE KEY uq_hcno_pub (company_id, pub_active),
  UNIQUE KEY uq_hcno_deadline (company_id, deadline_active),
  KEY idx_hcno_status (company_id, status),
  CONSTRAINT fk_hcno_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcno_pub     FOREIGN KEY (publication_id) REFERENCES hrms_compliance_publications(id),
  CONSTRAINT fk_hcno_ack     FOREIGN KEY (acknowledged_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_emails (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  notification_id  INT           NULL,
  to_user_id       INT           NOT NULL,
  to_email         VARCHAR(255)  NOT NULL,
  subject          VARCHAR(300)  NOT NULL,
  body_html        MEDIUMTEXT    NOT NULL,
  reason           ENUM('NEW','RESEND','REMINDER') NOT NULL DEFAULT 'NEW',
  status           ENUM('QUEUED','SENT','FAILED','SKIPPED') NOT NULL DEFAULT 'QUEUED',
  attempts         INT           NOT NULL DEFAULT 0,
  error            VARCHAR(500)  NULL,
  queued_at        DATETIME      NOT NULL,
  sent_at          DATETIME      NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_hcem_status (status, queued_at),
  KEY idx_hcem_company (company_id, status),
  CONSTRAINT fk_hcem_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcem_note    FOREIGN KEY (company_id, notification_id) REFERENCES hrms_compliance_notifications(company_id, id),
  CONSTRAINT fk_hcem_user    FOREIGN KEY (to_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_deadline_marks (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  deadline_key     VARCHAR(60)   NOT NULL,
  due_date         DATE          NOT NULL,
  done_at          DATETIME      NULL,
  done_by          INT           NULL,
  done_note        VARCHAR(500)  NULL,
  reminded_3_at    DATETIME      NULL,
  reminded_1_at    DATETIME      NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  key_active       VARCHAR(60)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, deadline_key, NULL)) VIRTUAL,

  UNIQUE KEY uq_hcdm_key (company_id, key_active),
  CONSTRAINT fk_hcdm_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcdm_done    FOREIGN KEY (done_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_reviews (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  rule_set         VARCHAR(60)   NOT NULL,
  status           ENUM('PENDING','APPROVED','QUESTIONED') NOT NULL DEFAULT 'PENDING',
  fingerprint      CHAR(64)      NULL,
  decided_by       INT           NULL,
  decided_at       DATETIME      NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  set_active       VARCHAR(60)   GENERATED ALWAYS AS (IF(deleted_at IS NULL, rule_set, NULL)) VIRTUAL,

  UNIQUE KEY uq_hcrv_set (company_id, set_active),
  CONSTRAINT fk_hcrv_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcrv_by      FOREIGN KEY (decided_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_review_comments (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  rule_set         VARCHAR(60)   NOT NULL,
  rule_key         VARCHAR(64)   NULL,
  action           ENUM('COMMENT','APPROVE','QUESTION') NOT NULL,
  body             VARCHAR(2000) NULL,
  user_id          INT           NOT NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_hcrc_set (company_id, rule_set, created_at),
  CONSTRAINT fk_hcrc_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcrc_user    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_signoffs (
  id               INT           AUTO_INCREMENT PRIMARY KEY,
  company_id       INT           NOT NULL,
  tax_year         VARCHAR(7)    NOT NULL,
  signed_by        INT           NOT NULL,
  signed_at        DATETIME      NOT NULL,
  note             VARCHAR(1000) NULL,
  snapshot_json    JSON          NULL,
  deleted_at       DATETIME      DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  year_active      VARCHAR(7)    GENERATED ALWAYS AS (IF(deleted_at IS NULL, tax_year, NULL)) VIRTUAL,

  UNIQUE KEY uq_hcso_year (company_id, year_active),
  CONSTRAINT fk_hcso_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcso_by      FOREIGN KEY (signed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ############################################################################
-- ## 37. LAW LAYER (CF_HRMS_HIRING_SPEC.md §36.1 — C1)                         ##
-- ############################################################################
-- Added 2026-10-24. THE LAW is product-level data (one copy for every company), versioned and
-- published by the product team; a company makes only CHOICES within it.
--
--   GLOBAL (no company_id; deleted_at):
--     hrms_law_rules              every rule version: domain (PF, ESI, PT, LWF, MIN_WAGE, BONUS, GRATUITY,
--                                 OVERTIME, WAGES, LEAVE_MIN …) × jurisdiction (IN or a state code) × rule_key ×
--                                 effective_from × version. DRAFT → PUBLISHED → SUPERSEDED. A PUBLISHED row
--                                 is NEVER edited (services/law refuses it): a change is a new version, and
--                                 publishing it supersedes the earlier one of the same rule and date. Several
--                                 effective dates of one rule are all PUBLISHED: each is in force from its
--                                 date until the next (or its effective_to).
--     hrms_tax_rules (§27)        gains the same version / status / publish fields (37b). Existing rows
--                                 are PUBLISHED version 1.
--
--   PER COMPANY (company_id + deleted_at):
--     hrms_law_company_choices    one row: the company's choices within the law (PF on the ceiling or on
--                                 the full wage for new salaries, its PF / ESI / PT / LWF registration
--                                 numbers, its bonus rate). Not law.
--     hrms_law_company_notes      the company's own note / "checked by our CA" against a law version.
--     hrms_location_law           a location's state and minimum-wage zone (a person's state = their
--                                 main position's location).
--     hrms_role_law               a role's skill category and scheduled employment (minimum wages).
--     hrms_pay_role_structures    a role's default salary structure, with an optional CTC band.
--     hrms_pay_runs.law_versions_json (37c)  the law and tax rule version ids a calculation used.
--
-- apps/cf_hrms/scripts/apply-law-schema.mjs applies exactly this (guarded, dry run by default);
-- migrate-statutory-to-law.mjs moves hrms_pay_statutory_settings into hrms_law_rules (the old table
-- stays, read by nothing, for the record); seed-law-rules.mjs adds the new law data.

CREATE TABLE IF NOT EXISTS hrms_law_rules (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  domain          VARCHAR(20)   NOT NULL,                 -- PF ESI PT LWF MIN_WAGE BONUS GRATUITY OVERTIME WAGES LEAVE_MIN
  jurisdiction    VARCHAR(10)   NOT NULL DEFAULT 'IN',    -- IN, or a state code (TG …)
  rule_key        VARCHAR(64)   NOT NULL,                 -- 'settings' (PF/ESI/PT/LWF), an employment key (MIN_WAGE) …
  title           VARCHAR(200)  NULL,
  value_json      JSON          NOT NULL,
  effective_from  DATE          NOT NULL,
  effective_to    DATE          NULL,                     -- NULL = until the next effective_from
  version         INT           NOT NULL DEFAULT 1,       -- per (domain, jurisdiction, rule_key, effective_from)
  status          ENUM('DRAFT','PUBLISHED','SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
  source_url      VARCHAR(500)  NULL,
  source_note     VARCHAR(2000) NULL,
  note            VARCHAR(1000) NULL,
  verified        TINYINT(1)    NOT NULL DEFAULT 0,
  reviewed_by     VARCHAR(120)  NULL,                     -- who published it (platform admin / script)
  published_at    DATETIME      NULL,
  review_by       DATE          NULL,                     -- look at it again by
  supersedes_id   INT           NULL,
  created_by      VARCHAR(120)  NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  published_key   TINYINT       GENERATED ALWAYS AS (IF(status = 'PUBLISHED' AND deleted_at IS NULL, 1, NULL)) VIRTUAL,

  UNIQUE KEY uq_hlr_version   (domain, jurisdiction, rule_key, effective_from, version),
  UNIQUE KEY uq_hlr_published (domain, jurisdiction, rule_key, effective_from, published_key),
  KEY idx_hlr_lookup (domain, jurisdiction, status, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_law_company_choices (
  id                    INT           AUTO_INCREMENT PRIMARY KEY,
  company_id            INT           NOT NULL,
  pf_wage_basis         ENUM('CEILING','FULL') NOT NULL DEFAULT 'CEILING',  -- the default for a new salary
  pf_establishment_code VARCHAR(40)   NULL,
  esi_employer_code     VARCHAR(40)   NULL,
  pt_registration_no    VARCHAR(40)   NULL,                 -- PT registration (employer)
  pt_enrolment_no       VARCHAR(40)   NULL,                 -- PT enrolment (the company itself)
  lwf_registration_no   VARCHAR(40)   NULL,
  bonus_rate            DECIMAL(5,2)  NULL,                 -- the company's bonus %, within the law's minimum and maximum
  note                  VARCHAR(1000) NULL,

  deleted_at            DATETIME      DEFAULT NULL,
  created_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by            INT           NULL,

  company_active        INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, company_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hlcc_company (company_active),
  CONSTRAINT fk_hlcc_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_law_company_notes (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  rule_id         INT           NOT NULL,                 -- hrms_law_rules.id
  verification    ENUM('VERIFIED','UNVERIFIED') NULL,     -- the company's own "checked" mark
  note            VARCHAR(500)  NULL,
  created_by      INT           NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  rule_active     INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, rule_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hlcn_rule (company_id, rule_active),
  CONSTRAINT fk_hlcn_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_location_law (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  location_id     INT           NOT NULL,
  state_code      VARCHAR(10)   NULL,                     -- TG …; NULL = the company's state
  min_wage_zone   VARCHAR(20)   NULL,                     -- the zone of the state's minimum-wage notification (I, II, III …)
  note            VARCHAR(500)  NULL,
  created_by      INT           NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  location_active INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, location_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hlol_location (company_id, location_active),
  CONSTRAINT fk_hlol_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hlol_location FOREIGN KEY (company_id, location_id) REFERENCES hrms_locations(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_role_law (
  id                   INT           AUTO_INCREMENT PRIMARY KEY,
  company_id           INT           NOT NULL,
  role_id              INT           NOT NULL,
  skill_category       ENUM('UNSKILLED','SEMI_SKILLED','SKILLED','HIGHLY_SKILLED') NULL,
  scheduled_employment VARCHAR(64)   NULL,                -- a MIN_WAGE rule_key of the state (e.g. ALL_EMPLOYMENTS)
  note                 VARCHAR(500)  NULL,
  created_by           INT           NULL,

  deleted_at           DATETIME      DEFAULT NULL,
  created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  role_active          INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, role_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hrlw_role (company_id, role_active),
  CONSTRAINT fk_hrlw_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrlw_role    FOREIGN KEY (company_id, role_id) REFERENCES hrms_roles(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_pay_role_structures (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  role_id         INT           NOT NULL,
  structure_id    INT           NOT NULL,
  ctc_min         DECIMAL(14,2) NULL,                     -- the role's CTC band (a year), optional
  ctc_max         DECIMAL(14,2) NULL,
  note            VARCHAR(500)  NULL,
  created_by      INT           NULL,

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  role_active     INT           GENERATED ALWAYS AS (IF(deleted_at IS NULL, role_id, NULL)) VIRTUAL,

  UNIQUE KEY uq_hprs_role (company_id, role_active),
  CONSTRAINT fk_hprs_company   FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hprs_role      FOREIGN KEY (company_id, role_id) REFERENCES hrms_roles(company_id, id),
  CONSTRAINT fk_hprs_structure FOREIGN KEY (company_id, structure_id) REFERENCES hrms_pay_structures(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 37b. hrms_tax_rules: versions, published the same way ------------------------------------
-- (apply-law-schema.mjs runs each step only when it is missing.)
-- "ALTER TABLE hrms_tax_rules ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER value_json"
-- "ALTER TABLE hrms_tax_rules ADD COLUMN status ENUM('DRAFT','PUBLISHED','SUPERSEDED') NOT NULL DEFAULT 'PUBLISHED' AFTER version"
-- "ALTER TABLE hrms_tax_rules ADD COLUMN reviewed_by VARCHAR(120) NULL AFTER verified"
-- "ALTER TABLE hrms_tax_rules ADD COLUMN published_at DATETIME NULL AFTER reviewed_by"
-- "ALTER TABLE hrms_tax_rules ADD COLUMN review_by DATE NULL AFTER published_at"
-- "ALTER TABLE hrms_tax_rules ADD COLUMN supersedes_id INT NULL AFTER review_by"
-- "ALTER TABLE hrms_tax_rules ADD COLUMN published_key TINYINT GENERATED ALWAYS AS (IF(status = 'PUBLISHED' AND deleted_at IS NULL, 1, NULL)) VIRTUAL"
-- "ALTER TABLE hrms_tax_rules ADD UNIQUE KEY uq_htr_version (tax_year, regime, rule_key, version)"
-- "ALTER TABLE hrms_tax_rules ADD UNIQUE KEY uq_htr_published (tax_year, regime, rule_key, published_key)"
-- "ALTER TABLE hrms_tax_rules DROP INDEX uq_htr_rule"
-- "UPDATE hrms_tax_rules SET published_at = created_at, reviewed_by = 'seed-tax-rules (version 1)' WHERE published_at IS NULL AND status = 'PUBLISHED'"

-- ----- 37c. hrms_pay_runs.law_versions_json ----------------------------------------------------
-- "ALTER TABLE hrms_pay_runs ADD COLUMN law_versions_json JSON NULL AFTER totals_json"



-- ############################################################################
-- ## 39. COMPLIANCE CHECKS (CF_HRMS_HIRING_SPEC.md §36.2, §36.3 — C2; bonus)  ##
-- ############################################################################
-- Added 2026-10-24. The checks themselves are code (services/complianceChecks/checks.js) against the
-- law in force (§37). What is stored is what a person decided about a check, the per-company to-dos
-- with their chosen fix, and the yearly statutory bonus.
--
--   hrms_compliance_acks       a WARN accepted with a reason and the approver: on a salary save, a
--                              structure save, before a run is locked, on a leave/attendance policy.
--                              context + entity_id say where; check_key + rule_id say which check
--                              against which law version (a later version asks again).
--   hrms_compliance_todos      per company: what no longer complies (one row per check x law version),
--                              people and structures affected (affected_json), deadline = the law's
--                              effective date. OPEN -> CHOSEN (HR picked a fix) -> APPLIED (the Owner
--                              approved; applied as dated salary rows / a new structure) - or RESOLVED
--                              (no longer found) / DISMISSED (a WARN, with a reason). One open row per
--                              todo_key (open_key). A HARD minimum-wage to-do past its deadline pays a
--                              statutory top-up line (component STAT_TOPUP) in each run until applied.
--   hrms_bonus_runs            the statutory bonus of an accounting year (Code on Wages ss.26-41):
--                              DRAFT (prepared by HR) -> APPROVED (the Owner, not the preparer) ->
--                              SCHEDULED (BONUS one-time items in a month's open run).
--   hrms_bonus_lines           one per person: eligible or why not, days worked, the wages and the
--                              calculation wage month by month (months_json), the bonus.
--   hrms_bonus_set_on_off      set-on / set-off of the allocable surplus, by year, carried up to 4 years.
--
-- apps/cf_hrms/scripts/apply-compliance-checks-schema.mjs applies exactly this (guarded, dry run by
-- default) and adds the STAT_TOPUP component to every company that has payroll components.

CREATE TABLE IF NOT EXISTS hrms_compliance_acks (
  id              INT           AUTO_INCREMENT PRIMARY KEY,
  company_id      INT           NOT NULL,
  context         ENUM('SALARY','STRUCTURE','RUN','LEAVE_POLICY','ATTENDANCE_POLICY','TODO') NOT NULL,
  entity_id       INT           NOT NULL,                 -- the salary / structure / run / policy / to-do id
  employee_id     INT           NULL,                     -- the person, where the check is a person's
  check_key       VARCHAR(40)   NOT NULL,                 -- MIN_WAGE, WAGES_50, PF_LEFT_OUT, OT_HOURS ...
  rule_id         INT           NULL,                     -- hrms_law_rules.id the check ran against
  message         VARCHAR(600)  NULL,                     -- what the warning said
  reason          VARCHAR(500)  NOT NULL,                 -- why it was accepted
  approved_by     INT           NULL,                     -- users.id of who accepted it

  deleted_at      DATETIME      DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_hcak_entity (company_id, context, entity_id),
  KEY idx_hcak_person (company_id, employee_id, check_key),
  CONSTRAINT fk_hcak_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hcak_by      FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_compliance_todos (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  todo_key          VARCHAR(120)  NOT NULL,               -- check_key:rule_id (one open to-do per break of a law version)
  check_key         VARCHAR(40)   NOT NULL,
  severity          ENUM('HARD','WARN','INFO') NOT NULL DEFAULT 'WARN',
  rule_id           INT           NULL,                   -- hrms_law_rules.id
  rule_version      INT           NULL,
  title             VARCHAR(300)  NOT NULL,
  message           VARCHAR(2000) NULL,
  effective_from    DATE          NULL,                   -- the law's effective date
  deadline          DATE          NULL,                   -- = effective_from
  status            ENUM('OPEN','CHOSEN','APPLIED','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
  people_count      INT           NOT NULL DEFAULT 0,
  structures_count  INT           NOT NULL DEFAULT 0,
  affected_json     JSON          NULL,                   -- { people: [...], structures: [...], policies: [...] }
  chosen_option     VARCHAR(40)   NULL,                   -- RESPLIT, RAISE_CTC, ADD_STATUTORY ...
  chosen_json       JSON          NULL,                   -- the preview HR chose (before / after)
  chosen_note       VARCHAR(500)  NULL,
  chosen_by         INT           NULL,
  chosen_at         DATETIME      NULL,
  approved_by       INT           NULL,
  approved_at       DATETIME      NULL,
  applied_at        DATETIME      NULL,
  applied_json      JSON          NULL,                   -- what was written: structures, salary rows, components
  letters           TINYINT(1)    NOT NULL DEFAULT 0,     -- revision letters asked for
  dismissed_reason  VARCHAR(500)  NULL,
  resolved_at       DATETIME      NULL,
  first_seen_at     DATETIME      NULL,
  last_checked_at   DATETIME      NULL,
  last_trigger      VARCHAR(20)   NULL,                   -- PUBLISH, NIGHTLY, CHECK_NOW, APPLY
  reminder_count    INT           NOT NULL DEFAULT 0,
  last_reminded_at  DATETIME      NULL,
  topup_from        CHAR(7)       NULL,                   -- the first run month a statutory top-up was paid
  created_by        INT           NULL,

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  open_key          VARCHAR(120)  GENERATED ALWAYS AS (IF(deleted_at IS NULL AND status IN ('OPEN','CHOSEN'), todo_key, NULL)) VIRTUAL,

  UNIQUE KEY uq_hctd_tenant (company_id, id),
  UNIQUE KEY uq_hctd_open (company_id, open_key),
  KEY idx_hctd_status (company_id, status, deadline),
  CONSTRAINT fk_hctd_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hctd_chooser  FOREIGN KEY (chosen_by) REFERENCES users(id),
  CONSTRAINT fk_hctd_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_bonus_runs (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  bonus_year         VARCHAR(7)    NOT NULL,              -- the accounting year, '2026-27' (1 April - 31 March)
  year_from          DATE          NOT NULL,
  year_to            DATE          NOT NULL,
  rate_pct           DECIMAL(5,2)  NOT NULL,              -- the company's choice, 8.33 ... 20
  status             ENUM('DRAFT','APPROVED','SCHEDULED') NOT NULL DEFAULT 'DRAFT',
  allocable_surplus  DECIMAL(16,2) NULL,                  -- optional: for set-on / set-off
  deadline           DATE          NULL,                  -- paid by (Code on Wages s.39: 8 months after the year)
  totals_json        JSON          NULL,
  law_json           JSON          NULL,                  -- the law versions used (ids) and their values
  note               VARCHAR(500)  NULL,
  prepared_by        INT           NULL,
  prepared_at        DATETIME      NULL,
  approved_by        INT           NULL,
  approved_at        DATETIME      NULL,
  pay_run_id         INT           NULL,                  -- the month's run that pays it
  pay_month          CHAR(7)       NULL,
  scheduled_by       INT           NULL,
  scheduled_at       DATETIME      NULL,

  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  year_active        VARCHAR(7)    GENERATED ALWAYS AS (IF(deleted_at IS NULL, bonus_year, NULL)) VIRTUAL,

  UNIQUE KEY uq_hbr_tenant (company_id, id),
  UNIQUE KEY uq_hbr_year (company_id, year_active),
  CONSTRAINT fk_hbr_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hbr_preparer FOREIGN KEY (prepared_by) REFERENCES users(id),
  CONSTRAINT fk_hbr_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_bonus_lines (
  id                INT           AUTO_INCREMENT PRIMARY KEY,
  company_id        INT           NOT NULL,
  bonus_run_id      INT           NOT NULL,
  employee_id       INT           NOT NULL,
  eligible          TINYINT(1)    NOT NULL DEFAULT 0,
  reason            VARCHAR(300)  NULL,                   -- why not eligible, or what was left out
  days_worked       DECIMAL(6,1)  NOT NULL DEFAULT 0,
  months_json       JSON          NULL,                   -- [{ month, payableDays, daysInMonth, wage, fullWage, counted, ceiling, calcWage }]
  wages_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  calc_wage_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  ceiling           DECIMAL(12,2) NULL,                   -- the monthly calculation ceiling (higher of Rs 7,000 and the minimum wage)
  amount            DECIMAL(12,2) NOT NULL DEFAULT 0,
  item_id           INT           NULL,                   -- hrms_pay_items.id once scheduled

  deleted_at        DATETIME      DEFAULT NULL,
  created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by        INT           NULL,

  KEY idx_hbl_run (company_id, bonus_run_id),
  CONSTRAINT fk_hbl_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hbl_run      FOREIGN KEY (company_id, bonus_run_id) REFERENCES hrms_bonus_runs(company_id, id),
  CONSTRAINT fk_hbl_employee FOREIGN KEY (company_id, employee_id) REFERENCES hrms_employees(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS hrms_bonus_set_on_off (
  id                 INT           AUTO_INCREMENT PRIMARY KEY,
  company_id         INT           NOT NULL,
  bonus_year         VARCHAR(7)    NOT NULL,              -- the year it arose in
  kind               ENUM('SET_ON','SET_OFF') NOT NULL,
  amount             DECIMAL(16,2) NOT NULL,
  carry_until_year   VARCHAR(7)    NULL,                  -- the 4th accounting year after (Code on Wages s.36)
  bonus_run_id       INT           NULL,
  note               VARCHAR(500)  NULL,

  deleted_at         DATETIME      DEFAULT NULL,
  created_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by         INT           NULL,

  KEY idx_hbso_year (company_id, bonus_year),
  CONSTRAINT fk_hbso_company FOREIGN KEY (company_id) REFERENCES companies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- ############################################################################
-- ## 41. UNIT REPORTING (CF_HRMS_HIRING_SPEC.md §40)                         ##
-- ############################################################################
-- Added 2026-10-24. The org unit tree is the backbone; reporting is anchored on POSITIONS and
-- follows the tree by default. A position's primary manager resolves in this order
-- (services/reportingResolver.js, lib/unitReporting.js):
--   1. its own explicit PRIMARY_MANAGER line (hrms_position_reporting_relationships)  -> EXPLICIT
--   2. else the head of its own unit (the head on its shift when the unit has a head per shift) -> UNIT_HEAD
--   3. for a head (or a unit with no head), the unit's Reports into                      -> REPORTS_INTO
--      DEFAULT = the parent unit's head (or, when the parent has none, the parent's own Reports into)
--      CHOSEN  = reports_into_position_id (the parent unit or a unit above; anywhere else needs a reason)
--   4. a vacant chair: the person is found by walking up the same order                -> WALKED_UP
--
-- DERIVED LINES ARE NOT STORED. They are computed on read from the tables below, in a fixed number
-- of company-wide queries, so they can never fall out of step with the tree, a head or a move.
-- Only the explicit lines are rows; one that leaves the tree may carry a reason.
--
--   hrms_unit_heads   one live head per (unit, shift) — shift NULL = the unit's one head.
--                     The head is a position of the unit or of a unit above (one position may
--                     head several units). Soft-deleted, never erased.
--   hrms_departments.reports_into_position_id / reports_into_mode / reports_into_reason
--   hrms_position_reporting_relationships.cross_tree_reason  — "mark as intended" for a primary
--                     line whose manager is outside the unit and the units above it.
-- Guarded ALTERs and the table: apps/cf_hrms/scripts/apply-unit-reporting-schema.mjs (dry run by default).

CREATE TABLE IF NOT EXISTS hrms_unit_heads (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NOT NULL,
  department_id    INT          NOT NULL,            -- the unit it heads
  position_id      INT          NOT NULL,            -- the chair (never a person)
  shift_id         INT          NULL,                -- NULL = the unit's one head; set = the head for that shift

  deleted_at       DATETIME     DEFAULT NULL,
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by       INT          NULL,

  head_key         VARCHAR(40)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, CONCAT(department_id, ':', IFNULL(shift_id, 0)), NULL)) VIRTUAL,

  UNIQUE KEY uq_huh_tenant (company_id, id),
  UNIQUE KEY uq_huh_live   (company_id, head_key),
  KEY idx_huh_unit     (company_id, department_id),
  KEY idx_huh_position (company_id, position_id),
  CONSTRAINT fk_huh_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_huh_unit     FOREIGN KEY (company_id, department_id) REFERENCES hrms_departments(company_id, id),
  CONSTRAINT fk_huh_position FOREIGN KEY (company_id, position_id) REFERENCES hrms_positions(company_id, id),
  CONSTRAINT fk_huh_shift    FOREIGN KEY (company_id, shift_id) REFERENCES hrms_shifts(company_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----- 41b. hrms_departments: Reports into -------------------------------------------------------
-- "ALTER TABLE hrms_departments ADD COLUMN reports_into_position_id INT NULL AFTER sort_order"
-- "ALTER TABLE hrms_departments ADD COLUMN reports_into_mode ENUM('DEFAULT','CHOSEN') NOT NULL DEFAULT 'DEFAULT' AFTER reports_into_position_id"
-- "ALTER TABLE hrms_departments ADD COLUMN reports_into_reason VARCHAR(500) NULL AFTER reports_into_mode"
-- "ALTER TABLE hrms_departments ADD KEY idx_hdep_reports_into (company_id, reports_into_position_id)"

-- ----- 41c. hrms_position_reporting_relationships: a cross-tree line marked as intended ----------
-- "ALTER TABLE hrms_position_reporting_relationships ADD COLUMN cross_tree_reason VARCHAR(500) NULL AFTER notes"
