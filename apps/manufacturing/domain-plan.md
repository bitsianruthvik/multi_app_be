# Manufacturing App — Domain Build Plan

## What This Document Covers

This document is the incremental build plan for the manufacturing project management app. It assumes
the following are already in place or in progress:

- Multi-tenant company/app/user/team/role model (existing)
- Query builder with CRUD + security injection (existing)
- Aggregation support added to query builder (Change 5 from `architecture/infra-multi-app-changes.md`)
- Soft deletes on all tables (Change 3)
- Resource registry merger — each app owns its `resourceDef.json` (Change 4)
- Per-app route structure under `apps/manufacturing/` (Change 9)
- Bull job queue infrastructure (Change 8)
- Structured logging (Change 6)

Everything described below is net-new and specific to the manufacturing app. It does not exist
anywhere in the current backend.

---

## App Overview

The app tracks the full lifecycle of manufacturing projects — each project produces one large final
product (a ship, plane, steel structure, etc.) through a hierarchy of stages and steps. It provides:

1. **Project planning** — define the full work breakdown structure before work starts
2. **Execution tracking** — record who did what, when, for how long, on which batch
3. **Plan vs actual** — compare every step's planned schedule against reality
4. **Delay capture** — when actual exceeds planned, require a reason
5. **Machine scheduling** — allocate shared machine time across steps; detect contention
6. **Bottleneck analysis** — identify which step, stage, or resource is the constraint on
   project throughput
7. **Parallel process support** — some steps can run concurrently; dependencies are modelled
   explicitly so the system knows what can start in parallel

---

## Domain Model

### Conceptual Hierarchy

```
Project
  └── Major Stage (e.g., "Hull Construction")
        └── Minor Stage (e.g., "Frame Assembly")
              └── Step (e.g., "Weld Frame Section A")
                    ├── Requires Sub-Products (from product catalog)
                    ├── Requires Raw Materials (from material catalog)
                    ├── Uses Machines (from machine catalog, scheduled time slots)
                    ├── Depends on other Steps (DAG edges — defines what can run in parallel)
                    └── Activity Log entries (who did it, when, which batch)

Project also has:
  └── Baseline Plan (frozen snapshot of all planned start/end times, taken before work starts)
  └── Delay Records (step-level, with reason code, linked to the activity that was late)
```

The major/minor stage distinction is for **reporting and dashboarding only**. The underlying data
model is a single `project_stages` table with a `parent_stage_id` self-reference and a
`stage_level` flag (`major` | `minor`). All logic — planning, execution, delays — applies equally
to both levels.

---

## Database Schema

All tables are company-scoped (`company_id INT NOT NULL`) and soft-deletable (`deleted_at DATETIME
NULL DEFAULT NULL`). Foreign keys use `ON DELETE RESTRICT` by default unless noted otherwise.

---

### Table 1: `mfg_projects`

Top-level project container. One row per manufacturing project per company.

```sql
CREATE TABLE mfg_projects (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT NOT NULL,
  name                VARCHAR(255) NOT NULL,
  description         TEXT,
  final_product_id    INT,                          -- FK → mfg_product_catalog.id (the end product)
  status              ENUM('draft','planned','in_progress','completed','on_hold') NOT NULL DEFAULT 'draft',
  planned_start_date  DATE,
  planned_end_date    DATE,
  actual_start_date   DATE,
  actual_end_date     DATE,
  created_by          INT NOT NULL,                 -- FK → users.id
  created_at          DATETIME NOT NULL DEFAULT NOW(),
  updated_at          DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at          DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id)       REFERENCES companies(id),
  FOREIGN KEY (created_by)       REFERENCES users(id)
);
```

---

### Table 2: `mfg_product_catalog`

Defines all products that can appear in any project — both final products and sub-products. A
sub-product is any intermediate assembly that is consumed by a step.

```sql
CREATE TABLE mfg_product_catalog (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(100),                     -- internal SKU / drawing number
  product_type    ENUM('final','sub_product') NOT NULL,
  unit            VARCHAR(50),                      -- e.g., 'piece', 'kg', 'meter'
  description     TEXT,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  updated_at      DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at      DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);
```

---

### Table 3: `mfg_raw_material_catalog`

Defines raw materials (steel plate, paint, bolts, etc.) available for use in steps.

```sql
CREATE TABLE mfg_raw_material_catalog (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(100),
  unit            VARCHAR(50) NOT NULL,             -- e.g., 'kg', 'litre', 'sheet'
  description     TEXT,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  updated_at      DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at      DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);
```

---

### Table 4: `mfg_machine_catalog`

Shared machines available for scheduling within a company. A machine can be used across multiple
projects simultaneously if its schedule allows.

```sql
CREATE TABLE mfg_machine_catalog (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(100),
  machine_type    VARCHAR(100),                     -- e.g., 'CNC', 'Welding Station', 'Press'
  capacity_unit   VARCHAR(50),                      -- what unit describes its capacity (hours/shift, etc.)
  notes           TEXT,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  updated_at      DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at      DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);
```

---

### Table 5: `mfg_project_stages`

Represents both major and minor stages. Minor stages have a `parent_stage_id` pointing to their
major stage. Major stages have `parent_stage_id = NULL`. The `stage_level` column drives reporting
display; the logic for execution and planning is identical at both levels.

```sql
CREATE TABLE mfg_project_stages (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT NOT NULL,
  project_id          INT NOT NULL,
  parent_stage_id     INT NULL,                     -- NULL = major stage; set = minor stage
  stage_level         ENUM('major','minor') NOT NULL,
  name                VARCHAR(255) NOT NULL,
  description         TEXT,
  sequence_order      INT NOT NULL DEFAULT 0,       -- display order within parent
  status              ENUM('not_started','in_progress','completed','blocked') NOT NULL DEFAULT 'not_started',
  planned_start_date  DATE,
  planned_end_date    DATE,
  actual_start_date   DATE,
  actual_end_date     DATE,
  created_at          DATETIME NOT NULL DEFAULT NOW(),
  updated_at          DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at          DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (project_id)      REFERENCES mfg_projects(id),
  FOREIGN KEY (parent_stage_id) REFERENCES mfg_project_stages(id)
);
```

---

### Table 6: `mfg_project_steps`

Individual units of work within a stage. Steps are where execution, scheduling, and activity
tracking actually happen.

```sql
CREATE TABLE mfg_project_steps (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  company_id            INT NOT NULL,
  project_id            INT NOT NULL,
  stage_id              INT NOT NULL,               -- FK → mfg_project_stages.id
  name                  VARCHAR(255) NOT NULL,
  description           TEXT,
  sequence_order        INT NOT NULL DEFAULT 0,
  output_product_id     INT NULL,                   -- FK → mfg_product_catalog.id (what this step produces, if any)
  output_quantity       DECIMAL(12,4),
  estimated_duration_hr DECIMAL(8,2),               -- planned hours for this step
  status                ENUM('not_started','in_progress','completed','blocked') NOT NULL DEFAULT 'not_started',
  planned_start_at      DATETIME,
  planned_end_at        DATETIME,
  actual_start_at       DATETIME,
  actual_end_at         DATETIME,
  created_at            DATETIME NOT NULL DEFAULT NOW(),
  updated_at            DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at            DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id)        REFERENCES companies(id),
  FOREIGN KEY (project_id)        REFERENCES mfg_projects(id),
  FOREIGN KEY (stage_id)          REFERENCES mfg_project_stages(id),
  FOREIGN KEY (output_product_id) REFERENCES mfg_product_catalog(id)
);
```

---

### Table 7: `mfg_step_product_requirements`

Links a step to the sub-products it requires as inputs. One step can require multiple sub-products
in specific quantities.

```sql
CREATE TABLE mfg_step_product_requirements (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  company_id        INT NOT NULL,
  step_id           INT NOT NULL,
  product_id        INT NOT NULL,                   -- FK → mfg_product_catalog.id
  required_quantity DECIMAL(12,4) NOT NULL,
  notes             TEXT,
  created_at        DATETIME NOT NULL DEFAULT NOW(),
  deleted_at        DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (step_id)    REFERENCES mfg_project_steps(id),
  FOREIGN KEY (product_id) REFERENCES mfg_product_catalog(id)
);
```

---

### Table 8: `mfg_step_material_requirements`

Links a step to the raw materials it consumes. Separate from product requirements because materials
come from a different catalog and are not produced by other steps.

```sql
CREATE TABLE mfg_step_material_requirements (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT NOT NULL,
  step_id             INT NOT NULL,
  material_id         INT NOT NULL,                 -- FK → mfg_raw_material_catalog.id
  required_quantity   DECIMAL(12,4) NOT NULL,
  actual_quantity     DECIMAL(12,4),                -- filled in during execution
  notes               TEXT,
  created_at          DATETIME NOT NULL DEFAULT NOW(),
  updated_at          DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at          DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (step_id)     REFERENCES mfg_project_steps(id),
  FOREIGN KEY (material_id) REFERENCES mfg_raw_material_catalog(id)
);
```

---

### Table 9: `mfg_machine_schedule_slots`

Allocates machine time to a specific step. A machine can have multiple non-overlapping slots across
different projects. Overlap detection is handled at the service layer (not a DB constraint, because
partial overlaps are complex to express as a constraint).

```sql
CREATE TABLE mfg_machine_schedule_slots (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  machine_id      INT NOT NULL,                     -- FK → mfg_machine_catalog.id
  step_id         INT NOT NULL,                     -- FK → mfg_project_steps.id
  project_id      INT NOT NULL,
  slot_type       ENUM('planned','actual') NOT NULL DEFAULT 'planned',
  scheduled_start DATETIME NOT NULL,
  scheduled_end   DATETIME NOT NULL,
  notes           TEXT,
  created_by      INT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  updated_at      DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at      DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (machine_id) REFERENCES mfg_machine_catalog(id),
  FOREIGN KEY (step_id)    REFERENCES mfg_project_steps(id),
  FOREIGN KEY (project_id) REFERENCES mfg_projects(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
```

---

### Table 10: `mfg_step_dependencies`

Defines which steps must be completed before another step can start. This is the DAG (directed
acyclic graph) that drives parallel process tracking. If step B depends on step A, B cannot start
until A is completed. Steps with no incoming dependency edges can start in parallel.

```sql
CREATE TABLE mfg_step_dependencies (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  company_id            INT NOT NULL,
  project_id            INT NOT NULL,
  predecessor_step_id   INT NOT NULL,               -- step that must finish first
  successor_step_id     INT NOT NULL,               -- step that can only start after predecessor
  dependency_type       ENUM('finish_to_start','finish_to_finish','start_to_start') NOT NULL DEFAULT 'finish_to_start',
  lag_hours             DECIMAL(6,2) DEFAULT 0,     -- optional buffer between predecessor end and successor start
  created_at            DATETIME NOT NULL DEFAULT NOW(),
  deleted_at            DATETIME NULL DEFAULT NULL,
  UNIQUE KEY uq_dep (project_id, predecessor_step_id, successor_step_id),
  FOREIGN KEY (company_id)          REFERENCES companies(id),
  FOREIGN KEY (project_id)          REFERENCES mfg_projects(id),
  FOREIGN KEY (predecessor_step_id) REFERENCES mfg_project_steps(id),
  FOREIGN KEY (successor_step_id)   REFERENCES mfg_project_steps(id)
);
```

---

### Table 11: `mfg_activity_log`

Records every unit of work performed — who did it, on which step, for which batch, from when to
when. This is the primary execution record. Multiple activity log entries can exist per step (a
step may be worked on across multiple sessions or by multiple workers on different batches).

```sql
CREATE TABLE mfg_activity_log (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  project_id      INT NOT NULL,
  step_id         INT NOT NULL,
  performed_by    INT NOT NULL,                     -- FK → users.id (the worker)
  team_id         INT NOT NULL,                     -- denormalised for reporting (from user at time of entry)
  batch_id        VARCHAR(100),                     -- free-form batch/lot identifier
  batch_quantity  DECIMAL(12,4),                    -- quantity processed in this activity
  started_at      DATETIME NOT NULL,
  ended_at        DATETIME,
  duration_min    DECIMAL(8,2)                      -- computed on ended_at write: (ended_at - started_at) in minutes
                  GENERATED ALWAYS AS (
                    CASE WHEN ended_at IS NOT NULL
                    THEN TIMESTAMPDIFF(MINUTE, started_at, ended_at)
                    ELSE NULL END
                  ) STORED,
  notes           TEXT,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  updated_at      DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  deleted_at      DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id)   REFERENCES companies(id),
  FOREIGN KEY (project_id)   REFERENCES mfg_projects(id),
  FOREIGN KEY (step_id)      REFERENCES mfg_project_steps(id),
  FOREIGN KEY (performed_by) REFERENCES users(id)
);
```

---

### Table 12: `mfg_delay_reasons`

Lookup table of delay reason codes. Company-specific so each company can define reasons that match
their operations (equipment failure, material shortage, labour absence, design change, etc.).

```sql
CREATE TABLE mfg_delay_reasons (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT NOT NULL,
  code        VARCHAR(50) NOT NULL,
  label       VARCHAR(255) NOT NULL,
  category    ENUM('equipment','material','labour','design','external','other') NOT NULL DEFAULT 'other',
  created_at  DATETIME NOT NULL DEFAULT NOW(),
  deleted_at  DATETIME NULL DEFAULT NULL,
  UNIQUE KEY uq_reason_code (company_id, code),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);
```

---

### Table 13: `mfg_step_delays`

Records a delay event for a specific step when actual duration exceeds planned. Linked to both the
step and the activity log entry that caused the overrun. A reason is mandatory.

```sql
CREATE TABLE mfg_step_delays (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT NOT NULL,
  project_id          INT NOT NULL,
  step_id             INT NOT NULL,
  activity_log_id     INT NOT NULL,                 -- FK → mfg_activity_log.id (the overrunning activity)
  delay_reason_id     INT NOT NULL,                 -- FK → mfg_delay_reasons.id
  planned_end_at      DATETIME NOT NULL,            -- snapshot of planned end at time of delay capture
  actual_end_at       DATETIME NOT NULL,
  delay_minutes       INT NOT NULL,                 -- actual_end_at - planned_end_at in minutes
  description         TEXT,                         -- free-text additional context
  reported_by         INT NOT NULL,                 -- FK → users.id
  created_at          DATETIME NOT NULL DEFAULT NOW(),
  deleted_at          DATETIME NULL DEFAULT NULL,
  FOREIGN KEY (company_id)      REFERENCES companies(id),
  FOREIGN KEY (project_id)      REFERENCES mfg_projects(id),
  FOREIGN KEY (step_id)         REFERENCES mfg_project_steps(id),
  FOREIGN KEY (activity_log_id) REFERENCES mfg_activity_log(id),
  FOREIGN KEY (delay_reason_id) REFERENCES mfg_delay_reasons.id),
  FOREIGN KEY (reported_by)     REFERENCES users(id)
);
```

---

### Table 14: `mfg_plan_baselines`

A frozen snapshot of the planned schedule for a project, taken when the project moves from `draft`
to `planned` (or at any explicit baseline-save moment). Once frozen, baseline data is never
updated — it exists solely for plan vs actual comparison. Multiple baselines can exist per project
(e.g., baseline 1 before start, baseline 2 after a scope change).

```sql
CREATE TABLE mfg_plan_baselines (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  project_id      INT NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  label           VARCHAR(255),                     -- e.g., "Pre-start baseline", "Post-change order 3"
  frozen_at       DATETIME NOT NULL DEFAULT NOW(),
  frozen_by       INT NOT NULL,
  notes           TEXT,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  deleted_at      DATETIME NULL DEFAULT NULL,
  UNIQUE KEY uq_baseline_version (project_id, version),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (project_id) REFERENCES mfg_projects(id),
  FOREIGN KEY (frozen_by)  REFERENCES users(id)
);
```

---

### Table 15: `mfg_baseline_step_snapshots`

Stores the planned values for each step at the time a baseline was frozen. References both the
baseline and the original step. This is what plan vs actual comparisons read from — not the live
`mfg_project_steps` row (which may have been replanned since the baseline).

```sql
CREATE TABLE mfg_baseline_step_snapshots (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  company_id            INT NOT NULL,
  baseline_id           INT NOT NULL,
  step_id               INT NOT NULL,
  step_name             VARCHAR(255) NOT NULL,      -- denormalised at freeze time
  stage_id              INT NOT NULL,
  planned_start_at      DATETIME,
  planned_end_at        DATETIME,
  estimated_duration_hr DECIMAL(8,2),
  created_at            DATETIME NOT NULL DEFAULT NOW(),
  FOREIGN KEY (company_id)  REFERENCES companies(id),
  FOREIGN KEY (baseline_id) REFERENCES mfg_plan_baselines(id),
  FOREIGN KEY (step_id)     REFERENCES mfg_project_steps(id)
);
```

---

## resourceDef.json Entries

All tables above need entries in `apps/manufacturing/resourceDef.json` to be accessible through the
shared query builder. The entries below define the fields, types, and allowed joins for each
resource. Standard CRUD (QUERY, INSERT, UPDATE, DELETE) becomes available immediately after
registration.

Key conventions:
- All fields use `alias.column` expressions where `alias` is the table alias
- `writeFields` lists columns set by the server (not passed by the client), e.g. `company_id`,
  `created_by`, `duration_min` (generated)
- `globalTable: false` on all manufacturing tables (company scoping always applied)

Resources to register (one block each):

| Resource key | Table | Notes |
|---|---|---|
| `mfg_projects` | `mfg_projects` | JOINs: users (created_by → name), mfg_product_catalog (final_product_id → name) |
| `mfg_product_catalog` | `mfg_product_catalog` | — |
| `mfg_raw_material_catalog` | `mfg_raw_material_catalog` | — |
| `mfg_machine_catalog` | `mfg_machine_catalog` | — |
| `mfg_project_stages` | `mfg_project_stages` | JOIN: mfg_projects (project name), self-join for parent stage name |
| `mfg_project_steps` | `mfg_project_steps` | JOINs: mfg_project_stages, mfg_product_catalog (output product) |
| `mfg_step_product_requirements` | `mfg_step_product_requirements` | JOINs: mfg_project_steps, mfg_product_catalog |
| `mfg_step_material_requirements` | `mfg_step_material_requirements` | JOINs: mfg_project_steps, mfg_raw_material_catalog |
| `mfg_machine_schedule_slots` | `mfg_machine_schedule_slots` | JOINs: mfg_machine_catalog, mfg_project_steps, users (created_by) |
| `mfg_step_dependencies` | `mfg_step_dependencies` | JOINs: mfg_project_steps ×2 (predecessor name, successor name) |
| `mfg_activity_log` | `mfg_activity_log` | JOINs: users (performed_by → name, role), mfg_project_steps |
| `mfg_delay_reasons` | `mfg_delay_reasons` | — |
| `mfg_step_delays` | `mfg_step_delays` | JOINs: mfg_delay_reasons, mfg_activity_log, users (reported_by) |
| `mfg_plan_baselines` | `mfg_plan_baselines` | JOINs: mfg_projects, users (frozen_by) |
| `mfg_baseline_step_snapshots` | `mfg_baseline_step_snapshots` | JOINs: mfg_plan_baselines, mfg_project_steps |

---

## Routes

All routes are mounted under `/api/query/v1/manufacturing/` by the app's `register()` function.
They are in addition to the generic CRUD that the shared `baseResourceRoute.js` provides for all
registered resources.

These custom routes handle operations that require business logic beyond what the query builder
can express.

---

### Route File: `routes/projectRoute.js`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/projects/:id/activate` | Transitions project from `draft` → `planned`; validates that all stages and steps have planned dates set |
| `POST` | `/projects/:id/start` | Transitions `planned` → `in_progress`; records `actual_start_date` |
| `POST` | `/projects/:id/freeze-baseline` | Calls baseline service to snapshot all step planned values into a new `mfg_plan_baselines` record + `mfg_baseline_step_snapshots` |
| `GET`  | `/projects/:id/work-breakdown` | Returns full hierarchical tree: project → major stages → minor stages → steps, in a single nested response (cannot be expressed as a flat query builder call) |
| `GET`  | `/projects/:id/gantt` | Returns step-level timeline data for Gantt chart rendering: step ID, name, planned start/end, actual start/end, status, dependencies |

---

### Route File: `routes/executionRoute.js`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/steps/:id/start-activity` | Creates an `mfg_activity_log` entry with `started_at = NOW()`, updates step status to `in_progress` |
| `POST` | `/steps/:id/end-activity` | Closes the open activity log entry (`ended_at = NOW()`); checks if actual exceeds planned; if yes, requires `delay_reason_id` and `description` in the body and creates an `mfg_step_delays` record; updates step status to `completed` |
| `GET`  | `/steps/:id/open-activity` | Returns the currently open (no `ended_at`) activity log entry for a step, if any |
| `POST` | `/steps/:id/machine-slot` | Creates a `mfg_machine_schedule_slots` entry; service layer checks for machine time overlap before inserting |
| `GET`  | `/machines/:id/schedule` | Returns all schedule slots for a machine within a date range, across all projects, ordered by scheduled_start |

---

### Route File: `routes/analyticsRoute.js`

Custom analytics endpoints that use complex SQL (CTEs, subqueries, multi-level aggregations) beyond
the scope of the standard query builder. All responses are read-only.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/:id/plan-vs-actual` | For every step in the project: baseline planned start/end vs actual start/end, variance in hours, delay count, delay reasons breakdown |
| `GET` | `/projects/:id/bottleneck-report` | Runs bottleneck analysis (see service below); returns ranked list of steps/stages/machines by total delay contribution |
| `GET` | `/projects/:id/critical-path` | Returns the sequence of steps with no parallel slack — the longest dependency chain from project start to end |
| `GET` | `/projects/:id/progress` | Stage and project-level completion percentages, based on steps completed vs total |
| `GET` | `/projects/:id/delay-summary` | Delay totals grouped by reason category and stage, sorted by cumulative delay minutes |
| `GET` | `/machines/utilization` | For a date range: per-machine total planned hours, total actual hours, and utilization percentage |
| `GET` | `/workers/performance` | Per-user: total activities, total duration, on-time vs delayed activity count |

---

## Services (Business Logic)

Services contain logic that does not belong in route handlers. Each service is a module in
`apps/manufacturing/services/`.

---

### `services/baselineService.js`

**Purpose:** Freeze a project plan as a named baseline.

**Inputs:** `project_id`, `label`, `user_id`, `company_id`

**What it does:**
1. Reads all `mfg_project_steps` for the project (non-deleted, with planned dates)
2. Creates a new `mfg_plan_baselines` row with an auto-incremented `version`
3. Inserts one `mfg_baseline_step_snapshots` row per step, copying `planned_start_at`,
   `planned_end_at`, `estimated_duration_hr`, `step_name`, `stage_id` at the moment of freezing
4. Returns the baseline ID

This service is called by `POST /projects/:id/freeze-baseline` and also automatically when
`POST /projects/:id/start` fires (system auto-baseline at project start if none exists).

---

### `services/dagService.js`

**Purpose:** Load and resolve the step dependency graph for a project.

**Inputs:** `project_id`, `company_id`

**What it does:**
- Loads all `mfg_step_dependencies` for the project
- Builds an adjacency list (Map of `step_id → [successor_step_ids]`)
- Exposes:
  - `getParallelGroups()` — topological sort; returns steps grouped by execution wave (steps in the
    same wave have all predecessors completed and can run in parallel)
  - `validateNoCycles()` — DFS cycle detection; throws if a cycle is found (prevents invalid
    dependency creation in the UI)
  - `getCriticalPath()` — finds the longest weighted path through the DAG (weights =
    `estimated_duration_hr`), returns the ordered list of steps on the critical path

**Used by:** `analyticsRoute.js` for critical path endpoint; `executionRoute.js` to determine
which steps are eligible to start at any given moment.

---

### `services/machineSchedulerService.js`

**Purpose:** Validate and manage machine time slot allocations.

**What it does:**
- `checkOverlap(machine_id, start, end, exclude_slot_id)` — queries `mfg_machine_schedule_slots`
  for any existing `planned` slots for the machine in the given window (excluding the slot being
  updated). Returns the conflicting slot(s) if any, null if clear.
- `getAvailableWindows(machine_id, from_date, to_date)` — returns free time windows for a machine
  within a date range, computed by diffing its schedule against the full date range. Used by the
  planning UI to suggest available slots.

**Used by:** `executionRoute.js` `POST /steps/:id/machine-slot`.

---

### `services/bottleneckService.js`

**Purpose:** Identify which steps, stages, or machines are most responsible for project delays.

**Inputs:** `project_id`, `company_id`

**Algorithm:**
1. Fetch all `mfg_step_delays` for the project, joined with `mfg_delay_reasons` and
   `mfg_project_steps`
2. Aggregate total delay minutes by: step, stage (minor), stage (major), delay reason category,
   and performing user
3. Fetch all `mfg_machine_schedule_slots` for the project; compute planned vs actual machine hours
4. Rank all dimensions by cumulative delay contribution (highest delay = rank 1)
5. Return a structured report:
   ```js
   {
     top_steps: [{ step_id, step_name, total_delay_min, delay_count }],
     top_stages: [{ stage_id, stage_name, level, total_delay_min }],
     top_reasons: [{ category, reason_label, total_delay_min, occurrence_count }],
     top_machines: [{ machine_id, machine_name, planned_hr, actual_hr, overrun_hr }],
     top_workers: [{ user_id, name, delayed_activities, total_delay_min }]
   }
   ```

**Used by:** `analyticsRoute.js` `GET /projects/:id/bottleneck-report`.

---

### `services/planVsActualService.js`

**Purpose:** Compute variance between baseline plan and actual execution for every step in a
project.

**Inputs:** `project_id`, `baseline_id` (optional — defaults to most recent baseline), `company_id`

**What it does:**
1. Loads `mfg_baseline_step_snapshots` for the given baseline
2. Loads `mfg_project_steps` actual values (`actual_start_at`, `actual_end_at`)
3. Loads `mfg_step_delays` grouped by step for delay count and reason summary
4. For each step, computes:
   - `start_variance_hr` = actual_start - baseline_planned_start (in hours; positive = late start)
   - `end_variance_hr` = actual_end - baseline_planned_end
   - `duration_variance_hr` = actual_duration - estimated_duration_hr
   - `status` = `on_time` | `delayed` | `early` | `not_started` | `in_progress`
5. Aggregates variances up to stage and project level (sum of step variances)

**Used by:** `analyticsRoute.js` `GET /projects/:id/plan-vs-actual`.

---

## Workers (Background Jobs)

Workers are registered with Bull via `apps/manufacturing/workers/jobHandlers.js` and use the
shared `core/jobs/queue.js` factory.

---

### Job: `manufacturing.bottleneck_refresh`

**Trigger:** Enqueued automatically when a step's activity log entry is closed (via
`POST /steps/:id/end-activity`) if the step is on the critical path, or every time a delay is
recorded.

**What it does:**
- Calls `bottleneckService.js` to recompute the bottleneck report for the project
- Stores the result in a `mfg_bottleneck_snapshots` cache table (a simple key-value snapshot table,
  see below) so the analytics endpoint returns pre-computed results instantly
- Marks the cache fresh with a `computed_at` timestamp

**Why background:** The bottleneck computation joins 5+ tables with aggregations. Running it inline
on every activity close would add 200-500ms to the worker's response. The slight staleness of a
background-computed result is acceptable for a dashboard view.

---

### Job: `manufacturing.delay_alert`

**Trigger:** Enqueued when an `mfg_step_delays` record is created.

**What it does:**
- Looks up the project supervisor (user with `supervisor` role in the project's company)
- Emits a structured log event at `warn` level with project, step, delay minutes, and reason
- (Future extension: send an email or push notification — the job infrastructure is in place; the
  notification channel just needs to be wired when required)

---

### Supporting Table: `mfg_bottleneck_snapshots`

Stores the pre-computed bottleneck report per project, refreshed by the background job.

```sql
CREATE TABLE mfg_bottleneck_snapshots (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  company_id      INT NOT NULL,
  project_id      INT NOT NULL UNIQUE,
  snapshot_json   JSON NOT NULL,
  computed_at     DATETIME NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT NOW(),
  updated_at      DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (project_id) REFERENCES mfg_projects(id)
);
```

---

## Planning Tool — How Planning Works End-to-End

The planning flow is the sequence of steps a planner goes through before work starts. This is not a
single endpoint — it is a workflow across multiple entities.

```
1. Create Project (mfg_projects — status: draft)
   └── Set final_product_id, planned_start_date, planned_end_date

2. Define Product & Material Catalog (if not already in company catalog)
   └── mfg_product_catalog, mfg_raw_material_catalog

3. Define Major Stages (mfg_project_stages — stage_level: major, parent_stage_id: null)
   └── Set sequence_order, planned_start_date, planned_end_date

4. Define Minor Stages (mfg_project_stages — stage_level: minor, parent_stage_id: <major id>)
   └── Same fields

5. Define Steps per Stage (mfg_project_steps)
   └── Set estimated_duration_hr, planned_start_at, planned_end_at
   └── Set output_product_id if this step produces a sub-product

6. Attach Requirements per Step
   └── mfg_step_product_requirements (which sub-products are needed as inputs)
   └── mfg_step_material_requirements (which raw materials are needed)

7. Define Step Dependencies (mfg_step_dependencies)
   └── DAG service validates no cycles after each addition
   └── dagService.getParallelGroups() can be called to preview parallel execution waves

8. Schedule Machines (mfg_machine_schedule_slots — slot_type: planned)
   └── machineSchedulerService.checkOverlap() validates no conflicts before insert

9. Activate Project (POST /projects/:id/activate)
   └── Validates all steps have planned dates
   └── Transitions status to: planned

10. Freeze Baseline (POST /projects/:id/freeze-baseline)
    └── baselineService.js snapshots all planned values
    └── Project is now ready for execution tracking
```

---

## Execution Tracking — How Reality Gets Recorded

```
1. Worker opens the app, sees their assigned steps (query mfg_project_steps filtered to their team)

2. Worker starts a step:
   POST /steps/:id/start-activity
   └── Creates mfg_activity_log { started_at: NOW(), performed_by: req.user.id, batch_id, batch_quantity }
   └── Updates mfg_project_steps status → in_progress

3. Worker finishes:
   POST /steps/:id/end-activity { ended_at: NOW() }
   └── Closes activity log (ended_at set, duration_min auto-computed by DB)
   └── Service checks: is actual_end_at > planned_end_at?
       ├── No → step status → completed
       └── Yes → requires delay_reason_id + description in request body
                 → creates mfg_step_delays record
                 → step status → completed
                 → enqueues manufacturing.delay_alert job
                 → enqueues manufacturing.bottleneck_refresh job

4. Machine time actuals:
   POST /steps/:id/machine-slot { slot_type: actual, scheduled_start, scheduled_end }
   └── Records what machine time was actually used vs planned
```

---

## Reporting & Dashboard Data Sources

The following table maps each dashboard view to the endpoint and underlying tables that feed it.

| Dashboard View | Endpoint | Primary Tables |
|---|---|---|
| Project overview card | `GET /projects/:id/progress` | mfg_projects, mfg_project_stages, mfg_project_steps |
| Gantt chart | `GET /projects/:id/gantt` | mfg_project_steps, mfg_step_dependencies, mfg_plan_baselines |
| Plan vs actual timeline | `GET /projects/:id/plan-vs-actual` | mfg_baseline_step_snapshots, mfg_project_steps, mfg_step_delays |
| Bottleneck heatmap | `GET /projects/:id/bottleneck-report` | mfg_bottleneck_snapshots (pre-computed) |
| Critical path view | `GET /projects/:id/critical-path` | mfg_project_steps, mfg_step_dependencies (DAG traversal) |
| Delay reasons breakdown | `GET /projects/:id/delay-summary` | mfg_step_delays, mfg_delay_reasons |
| Machine utilization | `GET /machines/utilization` | mfg_machine_schedule_slots, mfg_machine_catalog |
| Worker performance | `GET /workers/performance` | mfg_activity_log, users |
| Stage progress drill-down | Query builder (mfg_project_stages + aggregate) | mfg_project_stages, mfg_project_steps |
| Activity feed per step | Query builder (mfg_activity_log) | mfg_activity_log, users |
| Machine calendar | `GET /machines/:id/schedule` | mfg_machine_schedule_slots |

---

## Build Order

The recommended sequence balances dependency order with the ability to demonstrate value early.

| Phase | Items | Deliverable |
|---|---|---|
| **Phase 1 — Catalog & Setup** | Tables 2, 3, 4 + resourceDef entries | Planner can configure products, materials, machines |
| **Phase 2 — Project Structure** | Tables 1, 5, 6 + resourceDef entries + projectRoute activate/work-breakdown | Planner can build full project breakdown with stages and steps |
| **Phase 3 — Requirements & Dependencies** | Tables 7, 8, 10 + resourceDef entries + dagService | Planner can attach requirements and define parallel process structure |
| **Phase 4 — Planning & Baseline** | Tables 14, 15 + baselineService + activate/freeze endpoints | Full plan can be frozen before execution starts |
| **Phase 5 — Machine Scheduling** | Table 9 + machineSchedulerService + machine-slot endpoint | Planned machine time allocated with conflict detection |
| **Phase 6 — Execution Tracking** | Table 11 + executionRoute start/end-activity | Workers can log activity start/end with batch tracking |
| **Phase 7 — Delay Capture** | Tables 12, 13 + delay logic in end-activity + delay_alert job | Delays captured with reason at time of overrun |
| **Phase 8 — Analytics** | Tables 16 + bottleneckService + planVsActualService + analyticsRoute | Full plan vs actual, bottleneck, and critical path reports |
| **Phase 9 — Background Jobs** | bottleneck_refresh + delay_alert workers | Pre-computed analytics, delay alerting |
