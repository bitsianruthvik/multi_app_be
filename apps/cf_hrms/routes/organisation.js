/**
 * organisation.js — the fixed points everything else references (plan §7).
 *
 *   GET    /organisation/lookups                    locations + departments + shifts for pickers
 *
 *   GET    /organisation/departments                pre-ordered tree, depth + child counts; + type, isShared, serves[], and `types` in use
 *   POST   /organisation/departments                { name, parentId?, labelId? | type? (the label's name), isShared?,
 *                                                     serves?: [departmentId], status? } — rows carry type (label name) + labelId
 *   PUT    /organisation/departments/:id            same fields; parentId moves the branch (after its new siblings, or at
 *                                                     sortOrder); serves replaces the list. POST takes sortOrder too
 *                                                     (a "+" between siblings: that place, the later ones move down)
 *   PUT    /organisation/departments/order          { parentId: id | null, ids: [id] } — every sibling under one parent once,
 *                                                     in the order wanted -> { parentId, rows: [{ id, sortOrder }] }
 *   GET    /organisation/departments/:id/move-check ?parentId=  (blank = top) -> { unit, from, to, unitsUnder, positionsUnder,
 *                                                     allowed, problem, sentence } — the words of the move confirm; writes nothing
 *   DELETE /organisation/departments/:id
 *   GET    /organisation/departments/staffing  ?on=  every department's roles and positions (seats, filled, vacant,
 *                                                    who is in each seat) in ONE answer, cut from the org chart's own nodes
 *
 *   GET    /organisation/locations                  + locationType, address
 *   POST   /organisation/locations                  { name, locationType, parentId?, address?, status? }
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
 *   GET    /organisation/shifts                     { shifts } — each with its seven days, weekly hours, summary, calendar
 *   GET    /organisation/shifts/:id                 { shift }
 *   POST   /organisation/shifts                     { code, name, startTime?, endTime?, crossesMidnight?, graceInMinutes?, graceOutMinutes?, status? }
 *   PUT    /organisation/shifts/:id
 *   DELETE /organisation/shifts/:id
 *
 *   GET    /organisation/holiday-calendars          { calendars }
 *   GET    /organisation/holiday-calendars/:id?year=   { calendar, holidays, years }
 *   POST   /organisation/holiday-calendars          { name, description? }      PUT / DELETE /:id (409 IN_USE while a shift selects it)
 *   POST   /organisation/holiday-calendars/:id/holidays    { date, name, isOptional? }   409 DUPLICATE
 *   POST   /organisation/holiday-calendars/:id/copy-year   { fromYear, toYear } -> { copied, skipped, note }
 *
 *   GET    /organisation/holidays?year=             every calendar's, ordered by date
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
import { listed } from '../lib/listFilters.js';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, ANY_VIEW, guard, handle, ctx, intParam, dateParam } from '../lib/http.js';
import { departmentWrite, companyWide } from '../lib/gates.js';
import {
  lookups,
  listDepartments, createDepartment, updateDepartment, deleteDepartment, reorderDepartments, moveCheck,
  listLocations, createLocation, updateLocation, deleteLocation,
  listWorkContexts, createWorkContext, updateWorkContext, deleteWorkContext,
  listContractors, createContractor, updateContractor, deleteContractor,
  listShifts, getShiftDetail, createShift, updateShift, deleteShift,
  listHolidays, createHoliday, updateHoliday, deleteHoliday,
  listHolidayCalendars, getHolidayCalendar, createHolidayCalendar, updateHolidayCalendar, deleteHolidayCalendar,
  createCalendarHoliday, copyHolidayYear,
  listReportingTypes, createReportingType, updateReportingType, deleteReportingType,
} from '../services/organisationService.js';
import { departmentStaffing } from '../services/jobContentService.js';
import { listLabels, createLabel, updateLabel, reorderLabels, deleteLabel } from '../services/departmentLabelService.js';

const router = Router();

/**
 * One transaction per write, so the row and its hrms_audit_log entry land
 * together. TiDB has no triggers: an audit row written outside the transaction
 * is an audit row that can go missing.
 */
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));

// ----- pickers --------------------------------------------------------------
router.get('/organisation/lookups', guard(ANY_VIEW), handle((req) => lookups(pool, ctx(req).companyId)));

// ----- departments ----------------------------------------------------------
router.get('/organisation/departments', guard([PERM.org.view, PERM.positions.view]), listed('departments'), handle((req) => listDepartments(pool, ctx(req).companyId)));
// Who works in each department: its roles, the positions under each, and the
// people in them. org_view and nothing weaker — it names every occupant in the
// company, so the cf_hrms_self_view employee logins get a 403.
router.get('/organisation/departments/staffing', guard(PERM.org.view), handle((req) => departmentStaffing(pool, ctx(req).companyId, { on: dateParam(req.query.on) })));
router.post('/organisation/departments', guard(PERM.org.edit), departmentWrite({ creating: true }), handle((req) => tx(req, (db, c) => createDepartment(db, c, req.body))));
// The order of the units under one parent (spec §34): checked like a new unit under that parent (the scope covers the parent).
router.put('/organisation/departments/order', guard(PERM.org.edit), departmentWrite({ creating: true }), handle((req) => tx(req, (db, c) => reorderDepartments(db, c, req.body ?? {}))));
router.get('/organisation/departments/:id/move-check', guard(PERM.org.edit), handle((req) => moveCheck(pool, ctx(req).companyId, intParam(req.params.id), req.query.parentId ?? null)));
router.put('/organisation/departments/:id', guard(PERM.org.edit), departmentWrite(), handle((req) => tx(req, (db, c) => updateDepartment(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/departments/:id', guard(PERM.org.remove), departmentWrite(), handle((req) => tx(req, (db, c) => deleteDepartment(db, c, intParam(req.params.id)))));

// ----- department labels (spec §9) -------------------------------------------
// The company's own short list: Department, Section, Machine to begin with.
// Every department has exactly ONE label (`type` / `labelId`), one of these. A rename also renames it on
// every department that uses it; a delete in use is 409 IN_USE with
// detail.departmentCount unless ?moveTo=<labelId> says where its departments go.
//   GET    /organisation/department-labels            { labels: [{ id, name, sortOrder, departmentCount, defaultShiftId }],
//                                                      shifts: [{ id, code, name }] } (the choices of "New positions start on")
//   POST   /organisation/department-labels            { name, defaultShiftId?, colour? }     -> the label (also under `label`)
//   PUT    /organisation/department-labels/order      { ids: number[] }      -> { labels, shifts }
//   PUT    /organisation/department-labels/:id        { name?, sortOrder?, defaultShiftId?, colour? } -> the label (also under `label`)
//          colour: a palette key (blue teal green lime amber orange red pink purple indigo cyan slate), null = the default;
//          every label read carries `colour` (the key it shows) and `colourChosen` (stored, or null)
//          defaultShiftId = "New positions start on" (spec §17.2): a shift id, or null for none
//   DELETE /organisation/department-labels/:id        ?moveTo=<labelId>      -> { ok, id, departmentsMoved }
router.get('/organisation/department-labels', guard([PERM.org.view, PERM.positions.view]), handle((req) => listLabels(pool, ctx(req).companyId)));
router.post('/organisation/department-labels', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createLabel(db, c, req.body ?? {}))));
// Before /:id, or "order" would be read as an id.
router.put('/organisation/department-labels/order', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => reorderLabels(db, c, req.body ?? {}))));
router.put('/organisation/department-labels/:id', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateLabel(db, c, intParam(req.params.id), req.body ?? {}))));
router.delete('/organisation/department-labels/:id', guard(PERM.org.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteLabel(db, c, intParam(req.params.id), { moveTo: req.query.moveTo ?? null }))));

// ----- locations ------------------------------------------------------------
router.get('/organisation/locations', guard([PERM.org.view, PERM.positions.view]), listed('locations'), handle((req) => listLocations(pool, ctx(req).companyId)));
router.post('/organisation/locations', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createLocation(db, c, req.body))));
router.put('/organisation/locations/:id', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateLocation(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/locations/:id', guard(PERM.org.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteLocation(db, c, intParam(req.params.id)))));

// ----- work contexts --------------------------------------------------------
// A work context is NEVER a manager (plan §2 rule 3). Nothing here can make one:
// both reporting tables key on positions and employees, and no route in this
// file writes to either.
router.get('/organisation/work-contexts', guard([PERM.org.view, PERM.positions.view]), handle((req) => listWorkContexts(pool, ctx(req).companyId)));
router.post('/organisation/work-contexts', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createWorkContext(db, c, req.body))));
router.put('/organisation/work-contexts/:id', guard(PERM.org.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateWorkContext(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/work-contexts/:id', guard(PERM.org.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteWorkContext(db, c, intParam(req.params.id)))));

// ----- contractors (people permissions, see the header) ---------------------
router.get('/organisation/contractors', guard(PERM.employees.view), handle((req) => listContractors(pool, ctx(req).companyId)));
router.post('/organisation/contractors', guard(PERM.employees.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createContractor(db, c, req.body))));
router.put('/organisation/contractors/:id', guard(PERM.employees.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateContractor(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/contractors/:id', guard(PERM.employees.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteContractor(db, c, intParam(req.params.id)))));

// ----- shifts ---------------------------------------------------------------
router.get('/organisation/shifts', guard([PERM.time.view, PERM.positions.view]), listed('shifts'), handle((req) => listShifts(pool, ctx(req).companyId)));
router.get('/organisation/shifts/:id', guard([PERM.time.view, PERM.positions.view]), handle((req) => getShiftDetail(pool, ctx(req).companyId, intParam(req.params.id))));
router.post('/organisation/shifts', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createShift(db, c, req.body))));
router.put('/organisation/shifts/:id', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateShift(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/shifts/:id', guard(PERM.time.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteShift(db, c, intParam(req.params.id)))));

// ----- holiday calendars ----------------------------------------------------
// A named list of dated holidays; a shift selects one (spec §6.2).
router.get('/organisation/holiday-calendars', guard(PERM.time.view), listed('holidayCalendars'), handle((req) => listHolidayCalendars(pool, ctx(req).companyId)));
router.post('/organisation/holiday-calendars', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createHolidayCalendar(db, c, req.body ?? {}))));
router.get('/organisation/holiday-calendars/:id', guard(PERM.time.view), handle((req) => getHolidayCalendar(pool, ctx(req).companyId, intParam(req.params.id), { year: req.query.year })));
router.put('/organisation/holiday-calendars/:id', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateHolidayCalendar(db, c, intParam(req.params.id), req.body ?? {}))));
router.delete('/organisation/holiday-calendars/:id', guard(PERM.time.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteHolidayCalendar(db, c, intParam(req.params.id)))));
router.post('/organisation/holiday-calendars/:id/holidays', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createCalendarHoliday(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/organisation/holiday-calendars/:id/copy-year', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => copyHolidayYear(db, c, intParam(req.params.id), req.body ?? {}))));

// ----- holidays -------------------------------------------------------------
router.get('/organisation/holidays', guard(PERM.time.view), listed('holidays'), handle((req) => listHolidays(pool, ctx(req).companyId, { year: req.query.year })));
router.post('/organisation/holidays', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createHoliday(db, c, req.body))));
router.put('/organisation/holidays/:id', guard(PERM.time.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateHoliday(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/holidays/:id', guard(PERM.time.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteHoliday(db, c, intParam(req.params.id)))));

// ----- reporting relationship types -----------------------------------------
router.get('/organisation/reporting-types', guard([PERM.setup.view, PERM.positions.view]), listed('reportingTypes'), handle((req) => listReportingTypes(pool, ctx(req).companyId)));
router.post('/organisation/reporting-types', guard(PERM.setup.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => createReportingType(db, c, req.body))));
router.put('/organisation/reporting-types/:id', guard(PERM.setup.edit), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => updateReportingType(db, c, intParam(req.params.id), req.body))));
router.delete('/organisation/reporting-types/:id', guard(PERM.setup.remove), companyWide('This belongs to the whole company. Your access covers your org unit and everything under it.'), handle((req) => tx(req, (db, c) => deleteReportingType(db, c, intParam(req.params.id)))));

export default router;
