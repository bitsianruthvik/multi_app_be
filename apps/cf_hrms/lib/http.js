import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm, fail, isPermitted } from '../../../core/middleware/requirePerm.js';
import { HrmsError, translateDbError } from './errors.js';

/**
 * Permission tags — plan §6. Seeded by models/seed.sql; admins bypass them on
 * the backend (requirePerm), but the frontend's usePermission has NO bypass, so
 * an admin role still needs the grants for the screens to show.
 *
 * `pii` is the odd one out: it does not guard a route, it changes what a route
 * RETURNS. peopleService.js masks hrms_employee_identifiers.identifier_value
 * unless the caller holds it, and that column is deliberately absent from
 * resourceDef.json so the generic query API cannot return it unmasked.
 */
export const PERM = {
  orgView: 'cf_hrms_org_view',                    // org chart, departments, locations, contexts, positions, roles
  orgManage: 'cf_hrms_org_manage',                // locations, departments, work contexts, positions, formal reporting
  rolesManage: 'cf_hrms_roles_manage',            // roles and all role content + the six content masters
  peopleView: 'cf_hrms_people_view',              // employees and their assignments
  peopleManage: 'cf_hrms_people_manage',          // employees, identifiers, documents, employment events
  peoplePii: 'cf_hrms_people_pii',                // read unmasked statutory identifiers
  assignmentsManage: 'cf_hrms_assignments_manage',// work assignments, contexts, actual reporting, overlays
  attendanceView: 'cf_hrms_attendance_view',      // roster, attendance, regularisation
  attendanceManage: 'cf_hrms_attendance_manage',
  leaveView: 'cf_hrms_leave_view',                // balances, requests
  leaveManage: 'cf_hrms_leave_manage',            // types, balances, approval
  documentsGenerate: 'cf_hrms_documents_generate',// Role JD / Responsibility Profile
  importManage: 'cf_hrms_import_manage',          // the org-chart import
};

/** The tenant and user of a request. The company always comes from the token, never the URL. */
export function ctx(req) {
  const companyId = Number(req.user?.companyId ?? req.user?.company_id);
  if (!companyId) throw new HrmsError(401, 'NO_COMPANY', 'This session has no company.');
  const userId = Number(req.user?.id) || null;
  return { companyId, userId };
}

/** For a route whose permission depends on what it touches. Admins pass, as everywhere. */
export function assertPerm(req, tag) {
  if (!isPermitted(req.user, tag)) throw new HrmsError(403, 'FORBIDDEN', `Permission required: ${tag}`);
}

/** True when the caller may see unmasked PII. Used to decide a shape, not access. */
export const canSeePii = (req) => isPermitted(req.user, PERM.peoplePii);

/** protect + permission, as one middleware list. */
export const guard = (perm) => [protect, requirePerm(perm)];

/** Wraps an async handler: its return value is the JSON body; errors go through fail(). */
export const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    fail(res, translateDbError(err));
  }
};

/** Positive integer from a route param or body field, or a 422. */
export function intParam(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HrmsError(422, 'INVALID', `${name} must be a positive whole number.`);
  return n;
}

/**
 * An ISO date (YYYY-MM-DD) from a query param, or today. Almost every read in
 * this app is "as of a date" — active assignments, effective role content,
 * reporting lines — so the parsing lives here rather than in eleven routers.
 */
export function dateParam(value, name = 'on') {
  if (value === undefined || value === null || value === '') {
    return new Date().toISOString().slice(0, 10);
  }
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new HrmsError(422, 'INVALID', `${name} must be a date as YYYY-MM-DD.`);
  }
  return s;
}
