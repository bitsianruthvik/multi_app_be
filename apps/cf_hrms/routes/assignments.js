/**
 * assignments.js — work assignments, their contexts, their ACTUAL reporting and
 * their content overlays. The centre of the model. (Plan §5.6, §7.)
 *
 *   GET    /assignments/options            ?on=   every picker an assignment form needs
 *   GET    /assignments                    ?on=&employeeId=&roleId=&positionId=&status=&search=
 *                                                 &noPosition=1&primaryOnly=1&liveOnly=1
 *   POST   /assignments                    { employeeId*, roleId*, positionId?, departmentId?, locationId?,
 *                                            assignmentTitle?, allocationPercent?, isPrimary?, demoteOther?,
 *                                            defaultShiftId?, status?, effectiveFrom?, effectiveTo?, reason?,
 *                                            workContextIds?[], allowRoleException?, replacesId? }
 *   GET    /assignments/:id                ?on=   the record + this person's other assignments
 *   PUT    /assignments/:id                identity fields refused on a live assignment
 *   POST   /assignments/:id/status         { status }
 *   POST   /assignments/:id/end            { effectiveTo? }  ends its reporting rows and contexts too
 *   DELETE /assignments/:id                only a row that was never live
 *
 *   GET    /assignments/:id/contexts
 *   POST   /assignments/:id/contexts       { workContextId*, isPrimary?, effectiveFrom?, effectiveTo?, notes? }
 *   DELETE /work-assignment-contexts/:id
 *
 *   ── the two endpoints v1.1 §13.5 requires ──────────────────────────────
 *   GET    /assignments/:id/reporting-relationships  ?on=&includeEnded=1
 *          ALL active relationships with their scopes. Never one manager.
 *   GET    /assignments/:id/resolved-reporting       ?on=
 *          The position's formal defaults combined with this assignment's
 *          additions and narrowings, each row tagged with its origin layer.
 *          Both are served by services/reportingResolver.js, which is the ONLY
 *          implementation of that resolution in this app.
 *
 *   POST   /assignments/:id/reporting-relationships  { managerEmployeeId*, managerWorkAssignmentId?,
 *                                                      relationshipTypeId*, isPrimary?, scopeType?,
 *                                                      scopeLabel?, scopeWorkContextId?, scopeNotes?,
 *                                                      effectiveFrom?, effectiveTo?, replacesId? }
 *   PUT    /assignment-reporting-relationships/:id   non-identity fields only
 *   POST   /assignment-reporting-relationships/:id/end { effectiveTo? }
 *   DELETE /assignment-reporting-relationships/:id
 *   GET    /assignment-managers/:employeeId/assignments   which hat a chosen manager wears
 *
 *   GET    /assignments/:id/overrides
 *   POST   /assignments/:id/overrides      { contentType*, action*, one definition FK*, … }
 *   DELETE /work-assignment-content-overrides/:id
 *
 * ADDING A MANAGER IS CHEAP ON PURPOSE. A second manager never justifies a
 * second Role, Position or Work Assignment (v1.1 §13, taxonomy §17); partial
 * authority is a SCOPE on the row. Nothing here accepts or returns a single
 * `manager_id`, at any layer, in any shape.
 *
 * Reads: `cf_hrms_people_view`. Writes: `cf_hrms_assignments_manage`.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listAssignments, getAssignment, createAssignment, updateAssignment,
  setAssignmentStatus, endAssignment, deleteAssignment,
  listAssignmentContexts, addAssignmentContext, removeAssignmentContext,
  addAssignmentReporting, updateAssignmentReporting, endAssignmentReporting, removeAssignmentReporting,
  listAssignmentOverrides, addAssignmentOverride, removeAssignmentOverride,
  assignmentOptions, managerAssignments,
} from '../services/assignmentService.js';
import { assignmentRelationships, resolveReporting } from '../services/reportingResolver.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

// Before /assignments/:id, or "options" would be read as an id.
router.get('/assignments/options', guard(PERM.peopleView), handle((req) => assignmentOptions(pool, ctx(req).companyId, req.query)));

router.get('/assignments', guard(PERM.peopleView), handle((req) => listAssignments(pool, ctx(req).companyId, req.query)));
router.post('/assignments', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => createAssignment(db, c, req.body ?? {}))));
router.get('/assignments/:id', guard(PERM.peopleView), handle((req) => getAssignment(pool, ctx(req).companyId, id(req), req.query)));
router.put('/assignments/:id', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => updateAssignment(db, c, id(req), req.body ?? {}))));
router.post('/assignments/:id/status', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => setAssignmentStatus(db, c, id(req), req.body?.status))));
router.post('/assignments/:id/end', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => endAssignment(db, c, id(req), req.body ?? {}))));
router.delete('/assignments/:id', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => deleteAssignment(db, c, id(req)))));

router.get('/assignments/:id/contexts', guard(PERM.peopleView), handle((req) => listAssignmentContexts(pool, ctx(req).companyId, id(req))));
router.post('/assignments/:id/contexts', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => addAssignmentContext(db, c, id(req), req.body ?? {}))));
router.delete('/work-assignment-contexts/:id', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => removeAssignmentContext(db, c, id(req)))));

// v1.1 §13.5. The whole set, with scopes — this is the contract.
router.get('/assignments/:id/reporting-relationships', guard(PERM.peopleView),
  handle((req) => assignmentRelationships(pool, ctx(req).companyId, id(req), {
    on: req.query.on,
    includeEnded: req.query.includeEnded === '1' || req.query.includeEnded === 'true',
  })));
// v1.1 §13.5. Formal defaults + assignment additions/narrowings, each tagged with its layer.
router.get('/assignments/:id/resolved-reporting', guard(PERM.peopleView),
  handle((req) => resolveReporting(pool, ctx(req).companyId, id(req), { on: req.query.on })));

router.post('/assignments/:id/reporting-relationships', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => addAssignmentReporting(db, c, id(req), req.body ?? {}))));
router.put('/assignment-reporting-relationships/:id', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => updateAssignmentReporting(db, c, id(req), req.body ?? {}))));
router.post('/assignment-reporting-relationships/:id/end', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => endAssignmentReporting(db, c, id(req), req.body ?? {}))));
router.delete('/assignment-reporting-relationships/:id', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => removeAssignmentReporting(db, c, id(req)))));

/**
 * Which of a manager's own assignments they wear over this one. Namespaced
 * under /assignment-managers rather than /employees so it cannot collide with
 * people.js, which owns the /employees prefix.
 */
router.get('/assignment-managers/:id/assignments', guard(PERM.peopleView),
  handle((req) => managerAssignments(pool, ctx(req).companyId, id(req), { on: req.query.on })));

router.get('/assignments/:id/overrides', guard(PERM.peopleView), handle((req) => listAssignmentOverrides(pool, ctx(req).companyId, id(req))));
router.post('/assignments/:id/overrides', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => addAssignmentOverride(db, c, id(req), req.body ?? {}))));
router.delete('/work-assignment-content-overrides/:id', guard(PERM.assignmentsManage), handle((req) => tx(req, (db, c) => removeAssignmentOverride(db, c, id(req)))));

export default router;
