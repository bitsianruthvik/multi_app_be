-- ============================================================================
-- cf_hrms — permissions, app access and the two vocabularies the app cannot
-- start without. Run AFTER models/init.sql.
--
-- Idempotent: every insert checks first. `features.feature_tag` has no unique
-- key, so INSERT IGNORE would happily duplicate — the guard is a NOT EXISTS on
-- every statement, the same shape cf_erp's seed uses.
--
-- TENANT SCOPING: this file seeds no company_id literal anywhere. Everything
-- per-company is derived by joining `apps` on slug = 'cf_hrms', so a company
-- that does not have the app gets nothing, and a company that gets the app
-- later gets its defaults the next time this file runs. (The known trap in this
-- codebase is a seed that sets @companyId once at the top and then writes every
-- tenant's rows against it — there is deliberately no such variable here.)
-- ============================================================================


-- ############################################################################
-- ## 1. FEATURES — the rights of CF_HRMS_HIRING_SPEC.md §12.1               ##
-- ############################################################################
-- GENERATED from lib/access.js (ALL_TAGS, tagName): nine areas × view / edit /
-- remove / upload, and seven named rights. They must match lib/http.js PERM
-- exactly — which is built from the same file. All are 'frontend': the platform
-- copies only frontend tags into a login token from the company role.
--
-- The fourteen tags of the first release (cf_hrms_org_manage, _people_view …)
-- are NOT created any more. Where they exist they stay, and nothing reads them;
-- a company that still holds them is moved over by scripts/setup-access.mjs.
-- `features.feature_tag` is unique, deleted rows included — hence no deleted_at
-- test in the guard below.

INSERT INTO features (feature_name, feature_tag, type)
SELECT x.feature_name, x.feature_tag, 'frontend'
  FROM (
    SELECT 'CF HRMS: organisation — view' AS feature_name, 'cf_hrms_org_view' AS feature_tag UNION ALL
    SELECT 'CF HRMS: organisation — add and change', 'cf_hrms_org_edit' UNION ALL
    SELECT 'CF HRMS: organisation — remove', 'cf_hrms_org_remove' UNION ALL
    SELECT 'CF HRMS: organisation — upload from excel', 'cf_hrms_org_upload' UNION ALL
    SELECT 'CF HRMS: roles — view', 'cf_hrms_roles_view' UNION ALL
    SELECT 'CF HRMS: roles — add and change', 'cf_hrms_roles_edit' UNION ALL
    SELECT 'CF HRMS: roles — remove', 'cf_hrms_roles_remove' UNION ALL
    SELECT 'CF HRMS: roles — upload from excel', 'cf_hrms_roles_upload' UNION ALL
    SELECT 'CF HRMS: positions — view', 'cf_hrms_positions_view' UNION ALL
    SELECT 'CF HRMS: positions — add and change', 'cf_hrms_positions_edit' UNION ALL
    SELECT 'CF HRMS: positions — remove', 'cf_hrms_positions_remove' UNION ALL
    SELECT 'CF HRMS: positions — upload from excel', 'cf_hrms_positions_upload' UNION ALL
    SELECT 'CF HRMS: employees — view', 'cf_hrms_employees_view' UNION ALL
    SELECT 'CF HRMS: employees — add and change', 'cf_hrms_employees_edit' UNION ALL
    SELECT 'CF HRMS: employees — upload from excel', 'cf_hrms_employees_upload' UNION ALL
    SELECT 'CF HRMS: hiring — view', 'cf_hrms_hiring_view' UNION ALL
    SELECT 'CF HRMS: hiring — add and change', 'cf_hrms_hiring_edit' UNION ALL
    SELECT 'CF HRMS: documents — view', 'cf_hrms_documents_view' UNION ALL
    SELECT 'CF HRMS: documents — add and change', 'cf_hrms_documents_edit' UNION ALL
    SELECT 'CF HRMS: documents — remove', 'cf_hrms_documents_remove' UNION ALL
    SELECT 'CF HRMS: time — view', 'cf_hrms_time_view' UNION ALL
    SELECT 'CF HRMS: time — add and change', 'cf_hrms_time_edit' UNION ALL
    SELECT 'CF HRMS: time — remove', 'cf_hrms_time_remove' UNION ALL
    SELECT 'CF HRMS: time — upload from excel', 'cf_hrms_time_upload' UNION ALL
    SELECT 'CF HRMS: leave — view', 'cf_hrms_leave_view' UNION ALL
    SELECT 'CF HRMS: leave — add and change', 'cf_hrms_leave_edit' UNION ALL
    SELECT 'CF HRMS: leave — remove', 'cf_hrms_leave_remove' UNION ALL
    SELECT 'CF HRMS: setup — view', 'cf_hrms_setup_view' UNION ALL
    SELECT 'CF HRMS: setup — add and change', 'cf_hrms_setup_edit' UNION ALL
    SELECT 'CF HRMS: setup — remove', 'cf_hrms_setup_remove' UNION ALL
    SELECT 'CF HRMS: create an employee', 'cf_hrms_employee_create' UNION ALL
    SELECT 'CF HRMS: close an employee', 'cf_hrms_employee_close' UNION ALL
    SELECT 'CF HRMS: add employees from excel', 'cf_hrms_employee_bulk_add' UNION ALL
    SELECT 'CF HRMS: see contact details', 'cf_hrms_contact_view' UNION ALL
    SELECT 'CF HRMS: see pay', 'cf_hrms_pay_view' UNION ALL
    SELECT 'CF HRMS: manage logins and access', 'cf_hrms_access_manage' UNION ALL
    SELECT 'CF HRMS: see their own place', 'cf_hrms_self_view'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM features f WHERE f.feature_tag = x.feature_tag);


-- ############################################################################
-- ## 2. CAPABILITIES — one per right, named after it, holding only it       ##
-- ############################################################################
-- A capability that held two features would grant two. services/accessGrants.js
-- checks exactly this shape and repairs one that has drifted.

INSERT INTO features_capability (name, features_json)
SELECT f.feature_tag, JSON_ARRAY(f.id)
  FROM features f
 WHERE f.feature_tag IN (
         'cf_hrms_org_view', 'cf_hrms_org_edit', 'cf_hrms_org_remove', 'cf_hrms_org_upload',
         'cf_hrms_roles_view', 'cf_hrms_roles_edit', 'cf_hrms_roles_remove', 'cf_hrms_roles_upload',
         'cf_hrms_positions_view', 'cf_hrms_positions_edit', 'cf_hrms_positions_remove', 'cf_hrms_positions_upload',
         'cf_hrms_employees_view', 'cf_hrms_employees_edit', 'cf_hrms_employees_upload', 'cf_hrms_hiring_view',
         'cf_hrms_hiring_edit', 'cf_hrms_documents_view', 'cf_hrms_documents_edit', 'cf_hrms_documents_remove',
         'cf_hrms_time_view', 'cf_hrms_time_edit', 'cf_hrms_time_remove', 'cf_hrms_time_upload',
         'cf_hrms_leave_view', 'cf_hrms_leave_edit', 'cf_hrms_leave_remove', 'cf_hrms_setup_view',
         'cf_hrms_setup_edit', 'cf_hrms_setup_remove', 'cf_hrms_employee_create', 'cf_hrms_employee_close',
         'cf_hrms_employee_bulk_add', 'cf_hrms_contact_view', 'cf_hrms_pay_view', 'cf_hrms_access_manage',
         'cf_hrms_self_view')
   AND f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM features_capability fc WHERE fc.name = f.feature_tag AND fc.deleted_at IS NULL);


-- ############################################################################
-- ## 3. GRANTS — every company's admin role (the Owner) holds every right   ##
-- ############################################################################
-- The backend lets the Owner through anyway; the frontend has NO bypass, so
-- without these rows an Owner sees no screens. No broader than before: the same
-- one role per company that held all fourteen old tags now holds all of these.
-- Always for the company's OWN cf_hrms app (never app_id NULL, which the
-- platform reads as "every app"), and never twice: role_capability has no
-- unique key, so the NOT EXISTS is the only thing keeping a re-run from
-- doubling the rows.
-- A grant needs role_capability AND app_user_access (section 4) — one without
-- the other is the usual cause of "the app is there but empty".

INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, a.company_id, a.id, fc.capability_id
  FROM apps a
  JOIN roles r ON r.company_id = a.company_id AND LOWER(r.name) = 'admin' AND r.deleted_at IS NULL
  JOIN features_capability fc ON fc.deleted_at IS NULL AND fc.name IN (
         'cf_hrms_org_view', 'cf_hrms_org_edit', 'cf_hrms_org_remove', 'cf_hrms_org_upload',
         'cf_hrms_roles_view', 'cf_hrms_roles_edit', 'cf_hrms_roles_remove', 'cf_hrms_roles_upload',
         'cf_hrms_positions_view', 'cf_hrms_positions_edit', 'cf_hrms_positions_remove', 'cf_hrms_positions_upload',
         'cf_hrms_employees_view', 'cf_hrms_employees_edit', 'cf_hrms_employees_upload', 'cf_hrms_hiring_view',
         'cf_hrms_hiring_edit', 'cf_hrms_documents_view', 'cf_hrms_documents_edit', 'cf_hrms_documents_remove',
         'cf_hrms_time_view', 'cf_hrms_time_edit', 'cf_hrms_time_remove', 'cf_hrms_time_upload',
         'cf_hrms_leave_view', 'cf_hrms_leave_edit', 'cf_hrms_leave_remove', 'cf_hrms_setup_view',
         'cf_hrms_setup_edit', 'cf_hrms_setup_remove', 'cf_hrms_employee_create', 'cf_hrms_employee_close',
         'cf_hrms_employee_bulk_add', 'cf_hrms_contact_view', 'cf_hrms_pay_view', 'cf_hrms_access_manage',
         'cf_hrms_self_view')
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND fc.capability_id = (SELECT MIN(f2.capability_id) FROM features_capability f2 WHERE f2.name = fc.name AND f2.deleted_at IS NULL)
   AND NOT EXISTS (
     SELECT 1 FROM role_capability x
      WHERE x.role_id = r.id AND x.app_id = a.id AND x.capability_id = fc.capability_id AND x.deleted_at IS NULL);


-- ############################################################################
-- ## 3a. THE `Employee` ROLE — one capability, and only one                  ##
-- ############################################################################
-- Every company running cf_hrms gets a role called `Employee` holding exactly
-- `cf_hrms_self_view` and nothing else. This is the role every minted
-- shop-floor login carries (scripts/create-employee-logins.mjs), and it is
-- seeded here rather than created by that script so the permission model is
-- complete on its own: the script mints identities, it does not invent access.
--
-- WHY THE ROLE IS NAMED, NOT TAGGED. `requirePerm` and `isPermitted` both let
-- `role === 'admin'` through everything, by name, case-insensitively. So the
-- one thing this role must never be called is anything an admin check matches —
-- `Employee` is safe, and a company that renames it keeps its grants because
-- the grant is keyed on the role id, not the word.
--
-- Both rows are needed for a working grant, and this file can only write one of
-- them: `role_capability` is per ROLE (here), `app_user_access` is per USER (the
-- script, one row per minted login). A role_capability row on its own silently
-- grants nothing — it is the single most common cause of "the app is there but
-- empty" on this platform.

INSERT INTO roles (name, company_id)
SELECT 'Employee', a.company_id
  FROM apps a
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM roles r
      WHERE r.company_id = a.company_id AND LOWER(r.name) = 'employee' AND r.deleted_at IS NULL);

INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, a.company_id, a.id, fc.capability_id
  FROM apps a
  JOIN roles r ON r.company_id = a.company_id AND LOWER(r.name) = 'employee' AND r.deleted_at IS NULL
  JOIN features_capability fc ON fc.name = 'cf_hrms_self_view' AND fc.deleted_at IS NULL
       AND fc.capability_id = (SELECT MIN(f2.capability_id) FROM features_capability f2 WHERE f2.name = 'cf_hrms_self_view' AND f2.deleted_at IS NULL)
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability x
      WHERE x.role_id = r.id AND x.app_id = a.id AND x.capability_id = fc.capability_id AND x.deleted_at IS NULL);


-- ############################################################################
-- ## 3b. ACCESS ROLES — the two every company has from the start            ##
-- ############################################################################
-- hrms_access_roles is what this app adds to a platform role: its label and
-- its scope (init.sql §15). The company's `admin` role is the Owner — never
-- renamed, the platform's bypass is on that name — and `Employee` is Employee.
-- The other ready-made roles (HR manager, HR executive, Department head) are
-- made for a company by scripts/setup-access.mjs, not here: this file gives a
-- new company exactly what the old one did, and nothing more.

INSERT INTO hrms_access_roles (company_id, role_id, label, description, scope, template_key, is_locked)
SELECT a.company_id, r.id, t.label, t.description, t.scope, t.template_key, 1
  FROM apps a
  JOIN (
    SELECT 'admin' AS platform_name, 'OWNER' AS template_key, 'Owner' AS label, 'COMPANY' AS scope,
           'Everything, including logins and access. Its rights cannot be reduced.' AS description UNION ALL
    SELECT 'employee', 'EMPLOYEE', 'Employee', 'DEPARTMENT',
           'Their own place in the organisation, and nothing else.'
  ) t
  JOIN roles r ON r.company_id = a.company_id AND LOWER(r.name) = t.platform_name AND r.deleted_at IS NULL
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND r.id = (SELECT MIN(r2.id) FROM roles r2 WHERE r2.company_id = a.company_id AND LOWER(r2.name) = t.platform_name AND r2.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM hrms_access_roles x WHERE x.company_id = a.company_id AND x.role_id = r.id AND x.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM hrms_access_roles x WHERE x.company_id = a.company_id AND x.template_key = t.template_key AND x.deleted_at IS NULL);


-- ############################################################################
-- ## 4. APP ACCESS — users whose company role is admin may open the app     ##
-- ############################################################################
-- Employees are NOT covered here: their login does not exist yet when this file
-- runs. scripts/create-employee-logins.mjs writes one app_user_access row per
-- minted login, in the same transaction as the user row, for exactly that
-- reason.

INSERT INTO app_user_access (user_id, app_id, role_id, company_id)
SELECT u.id, a.id, u.role_id, a.company_id
  FROM apps a
  JOIN users u ON u.company_id = a.company_id AND u.deleted_at IS NULL
  JOIN roles r ON r.id = u.role_id AND LOWER(r.name) = 'admin'
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM app_user_access x WHERE x.user_id = u.id AND x.app_id = a.id AND x.deleted_at IS NULL);


-- ############################################################################
-- ## 5. REPORTING RELATIONSHIP TYPES — the six the model assumes            ##
-- ############################################################################
-- Reporting is typed, and nothing can be recorded until at least one type
-- exists: hrms_position_reporting_relationships.relationship_type_id and
-- hrms_assignment_reporting_relationships.relationship_type_id are both NOT NULL.
-- So these six are not a convenience, they are what makes the app usable on the
-- first day. Companies may add their own; these are never deleted by an upgrade.
--
--   is_formal      — does this type draw a solid line in the org chart and take
--                    part in the cycle check? PRIMARY / FUNCTIONAL / ADMIN yes.
--                    DOTTED, PROJECT and SHIFT are real reporting but not the
--                    formal hierarchy, so a project loop is not an org-chart cycle.
--   allow_multiple — may one source hold several of this type at once? PRIMARY
--                    is the only one that may not: a person has one primary
--                    manager per assignment, and the whole matrix depends on
--                    that being unambiguous.

INSERT INTO hrms_reporting_relationship_types (company_id, code, name, is_formal, allow_multiple, sort_order, status)
SELECT a.company_id, t.code, t.name, t.is_formal, t.allow_multiple, t.sort_order, 'ACTIVE'
  FROM apps a
  JOIN (
    -- Codes are the ones named in spec v1.1 §13.1. `allow_multiple = 0` on the
    -- primary manager only says one PRIMARY row per source at a time; it does
    -- not stop a dotted, functional or project manager sitting beside it
    -- (v1.1 §13.3 — `is_primary` is per reporting layer, not exclusive).
    SELECT 'PRIMARY_MANAGER' AS code, 'Primary Manager'     AS name, 1 AS is_formal, 0 AS allow_multiple, 10 AS sort_order UNION ALL
    SELECT 'FUNCTIONAL_MANAGER',     'Functional Manager',          1,                1,                20 UNION ALL
    SELECT 'ADMINISTRATIVE_MANAGER', 'Administrative Manager',      1,                1,                30 UNION ALL
    SELECT 'DOTTED_LINE',            'Dotted Line',                 0,                1,                40 UNION ALL
    SELECT 'PROJECT_MANAGER',        'Project Manager',             0,                1,                50 UNION ALL
    SELECT 'SHIFT_SUPERVISOR',       'Shift Supervisor',            0,                1,                60
  ) t
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM hrms_reporting_relationship_types x
      WHERE x.company_id = a.company_id AND x.code = t.code AND x.deleted_at IS NULL);


-- ############################################################################
-- ## 6. SHIFTS — G, D, N                                                    ##
-- ############################################################################
-- GENERAL SHIFT HAS NO TIMES, AND THAT IS DELIBERATE. The spec marks
-- shifts.start_time / end_time nullable precisely for the flexible general
-- shift: staff on G are expected during the working day, and writing 09:00-18:00
-- here would turn every ordinary late arrival into a fabricated exception the
-- moment attendance starts reading shift times.
--
-- D and N are the plant's two twelve-hour shifts. N carries crosses_midnight = 1,
-- which is what stops a night shift's worked hours being computed as negative —
-- out_time is the next calendar day, and hrms_attendance_records stores in_time
-- and out_time as TIMESTAMPs for the same reason.
--
-- The times below are a starting point a company edits on the Shifts screen;
-- the codes are what the org-chart import maps its G / D / N / DN values onto
-- (DN is two shifts' worth of people and becomes manpower requirements, not a
-- fourth shift).

INSERT INTO hrms_shifts (company_id, code, name, start_time, end_time, crosses_midnight, grace_in_minutes, grace_out_minutes, status)
SELECT a.company_id, s.code, s.name, s.start_time, s.end_time, s.crosses_midnight, 0, 0, 'ACTIVE'
  FROM apps a
  JOIN (
    SELECT 'G' AS code, 'General' AS name, CAST(NULL AS TIME) AS start_time, CAST(NULL AS TIME) AS end_time, 0 AS crosses_midnight UNION ALL
    SELECT 'D',         'Day',             CAST('08:00:00' AS TIME),         CAST('20:00:00' AS TIME),       0 UNION ALL
    SELECT 'N',         'Night',           CAST('20:00:00' AS TIME),         CAST('08:00:00' AS TIME),       1
  ) s
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM hrms_shifts x
      WHERE x.company_id = a.company_id AND x.code = s.code AND x.deleted_at IS NULL);

-- SEVEN DAYS FOR EVERY SHIFT THAT HAS NONE (2026-10-11, hrms_shift_days). A
-- shift's hours are per day of the week; one seeded a moment ago — or made
-- before the day rows existed — gets its own times on Monday to Saturday and
-- Sunday off (no times = working days without fixed hours). A weekday that
-- already has a row is left alone, so this never undoes an edit.
INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes)
SELECT s.company_id, s.id, d.weekday,
       IF(d.weekday <= 6, 1, 0),
       IF(d.weekday <= 6, s.start_time, NULL),
       IF(d.weekday <= 6, s.end_time, NULL),
       IF(d.weekday <= 6 AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.end_time <= s.start_time, 1, 0),
       0
  FROM hrms_shifts s
  JOIN (SELECT 1 AS weekday UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7) d
 WHERE s.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM hrms_shift_days x
      WHERE x.company_id = s.company_id AND x.shift_id = s.id AND x.weekday = d.weekday);
-- (hrms_shifts.week_summary is left NULL here: a reader with no stored line
-- prints the line of exactly this default week — services/shiftRead.js — and the
-- application writes the column on the first edit.)
