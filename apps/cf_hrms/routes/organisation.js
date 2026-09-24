/**
 * organisation.js — the fixed points everything else references (plan §7).
 *
 *   GET    /organisation/lookups                    locations + departments + shifts for pickers
 *
 *   GET    /organisation/departments                pre-ordered tree, depth + child counts
 *   POST   /organisation/departments                { name, code?, parentId?, status? }
 *   PUT    /organisation/departments/:id            same fields; parentId moves the branch
 *   DELETE /organisation/departments/:id
 *
 *   GET    /organisation/locations                  + locationType, address
 *   POST   /organisation/locations                  { name, code?, locationType, parentId?, address?, status? }
 *   PUT    /organisation/locations/:id
 *   DELETE /organisation/locations/:id
 *
 *   GET    /organisation/work-contexts              + contextType, location, department
 *   POST   /organisation/work-contexts              { name, code?, contextType, parentId?, locationId?, departmentId?, externalRef?, status? }
 *   PUT    /organisation/work-contexts/:id
 *   DELETE /organisation/work-contexts/:id
 *
 *   GET    /organisation/contractors                + employee counts          (people permissions)
 *   POST   /organisation/contractors                { name, code?, contact?, status? }
 *   PUT    /organisation/contractors/:id
 *   DELETE /organisation/contractors/:id
 *
 *   GET    /organisation/shifts
 *   POST   /organisation/shifts                     { code, name, startTime?, endTime?, crossesMidnight?, graceInMinutes?, graceOutMinutes?, status? }
 *   PUT    /organisation/shifts/:id
 *   DELETE /organisation/shifts/:id
 *
 *   GET    /organisation/holidays?year=             ordered by date
 *   POST   /organisation/holidays                   { holidayDate, name, locationId?, isOptional? }
 *   PUT    /organisation/holidays/:id
 *   DELETE /organisation/holidays/:id
 *
 *   GET    /organisation/reporting-types            + how many lines use each
 *   POST   /organisation/reporting-types            { code, name, isFormal?, allowMultiple?, sortOrder? }
 *   PUT    /organisation/reporting-types/:id        code is permanent
 *   DELETE /organisation/reporting-types/:id
 *
 * PERMISSIONS (plan §6). `cf_hrms_org_view` reads and `cf_hrms_org_manage`
 * writes, EXCEPT contractors: a contractor is an employer of people, it is read
 * on the employee form and edited by whoever maintains employees, so it carries
 * `cf_hrms_people_view` / `cf_hrms_people_manage`. Giving someone the org grant
 * should not also hand them the contract-labour register.
 *
 * The company always comes from the token via ctx(req) — never from
 * :companySlug, which appContext only uses to resolve the app.
 *
 * Reads here rather than through the generic query API because every one of
 * them carries something the query engine cannot produce: tree order and depth,
 * a resolved parent path, a usage count that decides whether a delete is
 * offered, or the flexible-shift shape. Writes are never generic: the rules in
 * organisationService.js are the ones TiDB cannot hold.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  lookups,
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listLocations, createLocation, updateLocation, deleteLocation,
  listWorkContexts, createWorkContext, updateWorkContext, deleteWorkContext,
  listContractors, createContractor, updateContractor, deleteContractor,
  listShifts, createShift, updateShift, deleteShift,
  listHolidays, createHoliday, updateHoliday, deleteHoliday,
  listReportingTypes, createReportingType, updateReportingType, deleteReportingType,
} from '../services/organisationService.js';

const router = Router();

/**
 * One transaction per write, so the row and its hrms_audit_log entry land
 * together. TiDB has no triggers: an audit row written outside the transaction
 * is an audit row that can go missing.
 */
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));

// ----- pickers --------------------------------------------------------------
router.get('/organisation/lookups', guard(PERM.orgView), handle((req) => lookups(pool, ctx(req).companyId)));

// ----- departments ----------------------------------------------------------
router.get('/organisation/departments', guard(PERM.orgView), handle((req) => listDepartments(pool, ctx(req).companyId)));
router.post('/organisation/departments', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createDepartment(db, c, req.body))));
router.put('/organisation/departments/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updateDepartment(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/departments/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deleteDepartment(db, c, intParam(req.params.id)))));

// ----- locations ------------------------------------------------------------
router.get('/organisation/locations', guard(PERM.orgView), handle((req) => listLocations(pool, ctx(req).companyId)));
router.post('/organisation/locations', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createLocation(db, c, req.body))));
router.put('/organisation/locations/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updateLocation(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/locations/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deleteLocation(db, c, intParam(req.params.id)))));

// ----- work contexts --------------------------------------------------------
// A work context is NEVER a manager (plan §2 rule 3). Nothing here can make one:
// both reporting tables key on positions and employees, and no route in this
// file writes to either.
router.get('/organisation/work-contexts', guard(PERM.orgView), handle((req) => listWorkContexts(pool, ctx(req).companyId)));
router.post('/organisation/work-contexts', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createWorkContext(db, c, req.body))));
router.put('/organisation/work-contexts/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updateWorkContext(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/work-contexts/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deleteWorkContext(db, c, intParam(req.params.id)))));

// ----- contractors (people permissions, see the header) ---------------------
router.get('/organisation/contractors', guard(PERM.peopleView), handle((req) => listContractors(pool, ctx(req).companyId)));
router.post('/organisation/contractors', guard(PERM.peopleManage), handle((req) => tx(req, (db, c) => createContractor(db, c, req.body))));
router.put('/organisation/contractors/:id', guard(PERM.peopleManage), handle((req) => tx(req, (db, c) => updateContractor(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/contractors/:id', guard(PERM.peopleManage), handle((req) => tx(req, (db, c) => deleteContractor(db, c, intParam(req.params.id)))));

// ----- shifts ---------------------------------------------------------------
router.get('/organisation/shifts', guard(PERM.orgView), handle((req) => listShifts(pool, ctx(req).companyId)));
router.post('/organisation/shifts', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createShift(db, c, req.body))));
router.put('/organisation/shifts/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updateShift(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/shifts/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deleteShift(db, c, intParam(req.params.id)))));

// ----- holidays -------------------------------------------------------------
router.get('/organisation/holidays', guard(PERM.orgView), handle((req) => listHolidays(pool, ctx(req).companyId, { year: req.query.year })));
router.post('/organisation/holidays', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createHoliday(db, c, req.body))));
router.put('/organisation/holidays/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updateHoliday(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/holidays/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deleteHoliday(db, c, intParam(req.params.id)))));

// ----- reporting relationship types -----------------------------------------
router.get('/organisation/reporting-types', guard(PERM.orgView), handle((req) => listReportingTypes(pool, ctx(req).companyId)));
router.post('/organisation/reporting-types', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createReportingType(db, c, req.body))));
router.put('/organisation/reporting-types/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updateReportingType(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/reporting-types/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deleteReportingType(db, c, intParam(req.params.id)))));

export default router;
