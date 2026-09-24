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
-- ## 1. FEATURES — the thirteen permission tags of plan §6                  ##
-- ############################################################################
-- These must match lib/http.js PERM exactly. `type` is 'frontend' for a tag the
-- UI gates a screen on and 'backend' for one that guards a write; the platform
-- treats both the same, it is documentation for whoever reads the features list.

INSERT INTO features (feature_name, feature_tag, type)
SELECT x.feature_name, x.feature_tag, x.type
  FROM (
    SELECT 'CF HRMS: view organisation, roles and positions' AS feature_name, 'cf_hrms_org_view'           AS feature_tag, 'frontend' AS type UNION ALL
    SELECT 'CF HRMS: manage locations, departments, contexts, positions and formal reporting', 'cf_hrms_org_manage',         'backend'  UNION ALL
    SELECT 'CF HRMS: manage roles and all role content',      'cf_hrms_roles_manage',        'backend'  UNION ALL
    SELECT 'CF HRMS: view employees and their assignments',   'cf_hrms_people_view',         'frontend' UNION ALL
    SELECT 'CF HRMS: manage employees, documents and events', 'cf_hrms_people_manage',       'backend'  UNION ALL
    SELECT 'CF HRMS: read unmasked statutory identifiers',    'cf_hrms_people_pii',          'backend'  UNION ALL
    SELECT 'CF HRMS: manage work assignments and actual reporting', 'cf_hrms_assignments_manage', 'backend'  UNION ALL
    SELECT 'CF HRMS: view roster and attendance',             'cf_hrms_attendance_view',     'frontend' UNION ALL
    SELECT 'CF HRMS: manage roster, attendance and regularisation', 'cf_hrms_attendance_manage', 'backend'  UNION ALL
    SELECT 'CF HRMS: view leave balances and requests',       'cf_hrms_leave_view',          'frontend' UNION ALL
    SELECT 'CF HRMS: manage leave types, balances and approvals', 'cf_hrms_leave_manage',    'backend'  UNION ALL
    SELECT 'CF HRMS: generate JD and responsibility profiles','cf_hrms_documents_generate',  'backend'  UNION ALL
    SELECT 'CF HRMS: run the org-chart import',               'cf_hrms_import_manage',       'backend'
  ) x
 WHERE NOT EXISTS (SELECT 1 FROM features f WHERE f.feature_tag = x.feature_tag AND f.deleted_at IS NULL);


-- ############################################################################
-- ## 2. CAPABILITIES — one per feature, named after it                      ##
-- ############################################################################

INSERT INTO features_capability (name, features_json)
SELECT f.feature_tag, JSON_ARRAY(f.id)
  FROM features f
 WHERE f.feature_tag IN ('cf_hrms_org_view', 'cf_hrms_org_manage', 'cf_hrms_roles_manage',
                         'cf_hrms_people_view', 'cf_hrms_people_manage', 'cf_hrms_people_pii',
                         'cf_hrms_assignments_manage', 'cf_hrms_attendance_view', 'cf_hrms_attendance_manage',
                         'cf_hrms_leave_view', 'cf_hrms_leave_manage', 'cf_hrms_documents_generate',
                         'cf_hrms_import_manage')
   AND f.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM features_capability fc WHERE fc.name = f.feature_tag AND fc.deleted_at IS NULL);


-- ############################################################################
-- ## 3. GRANTS — every company's admin role gets all thirteen               ##
-- ############################################################################
-- The backend lets admins through anyway (requirePerm); the frontend's
-- usePermission has NO bypass, so without these rows an admin sees no screens.
-- A grant needs role_capability AND app_user_access (section 4) — one without
-- the other is the usual cause of "the app is there but empty".

INSERT INTO role_capability (role_id, team_id, company_id, app_id, capability_id)
SELECT r.id, NULL, a.company_id, a.id, fc.capability_id
  FROM apps a
  JOIN roles r ON r.company_id = a.company_id AND LOWER(r.name) = 'admin' AND r.deleted_at IS NULL
  JOIN features_capability fc ON fc.name IN ('cf_hrms_org_view', 'cf_hrms_org_manage', 'cf_hrms_roles_manage',
                         'cf_hrms_people_view', 'cf_hrms_people_manage', 'cf_hrms_people_pii',
                         'cf_hrms_assignments_manage', 'cf_hrms_attendance_view', 'cf_hrms_attendance_manage',
                         'cf_hrms_leave_view', 'cf_hrms_leave_manage', 'cf_hrms_documents_generate',
                         'cf_hrms_import_manage')
                             AND fc.deleted_at IS NULL
 WHERE a.slug = 'cf_hrms' AND a.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM role_capability x
      WHERE x.role_id = r.id AND x.app_id = a.id AND x.capability_id = fc.capability_id AND x.deleted_at IS NULL);


-- ############################################################################
-- ## 4. APP ACCESS — users whose company role is admin may open the app     ##
-- ############################################################################

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
