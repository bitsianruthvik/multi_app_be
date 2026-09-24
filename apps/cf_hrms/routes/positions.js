/**
 * positions.js — positions, their work contexts, the FORMAL reporting structure
 * and position content overlays. (Plan §5.4, §7.)
 *
 *   GET    /positions/options                          every picker a position form needs, in one request
 *   GET    /positions                     ?on=&status=&roleId=&departmentId=&locationId=&search=
 *                                                      rows + sanctioned/filled/vacant totals over the SAME filtered set
 *   POST   /positions                     { roleId*, positionCode?, positionTitle?, departmentId?, locationId?,
 *                                           sanctionedHeadcount?, defaultShiftId?, status?, effectiveFrom?, effectiveTo? }
 *   GET    /positions/:id                 ?on=
 *   PUT    /positions/:id                 same fields, all optional
 *   POST   /positions/:id/status          { status }   DRAFT / ACTIVE / FROZEN / CLOSED
 *   DELETE /positions/:id                 refused while anyone is assigned to the seat
 *
 *   GET    /positions/:id/work-contexts
 *   POST   /positions/:id/work-contexts   { workContextId*, isPrimary?, effectiveFrom?, effectiveTo?, notes? }
 *   PUT    /position-work-contexts/:id    { isPrimary?, effectiveFrom?, effectiveTo?, notes? }
 *   DELETE /position-work-contexts/:id
 *
 *   GET    /positions/:id/reporting-relationships   ?on=&includeEnded=1   managers AND direct reports
 *   GET    /positions/:id/resolved-reporting        ?on=   formal rows with each seat's occupants resolved
 *   POST   /positions/:id/reporting-relationships   { toPositionId*, relationshipTypeId*, isPrimary?,
 *                                                     scopeType?, scopeLabel?, scopeWorkContextId?,
 *                                                     effectiveFrom?, effectiveTo?, notes?, replacesId? }
 *   PUT    /position-reporting-relationships/:id    non-identity fields only
 *   POST   /position-reporting-relationships/:id/end { effectiveTo? }
 *   DELETE /position-reporting-relationships/:id
 *
 *   GET    /positions/:id/occupants       ?on=   the assignments filling this seat
 *
 *   GET    /positions/:id/overrides
 *   POST   /positions/:id/overrides       { contentType*, action*, one definition FK*, parentKraDefinitionId?,
 *                                           overrideJson?, effectiveFrom?, effectiveTo?, reason? }
 *   DELETE /position-content-overrides/:id
 *
 * MULTIPLE REPORTING ROWS PER POSITION ARE NORMAL (v1.1 §13.1). A primary line
 * plus a scoped dotted line is two rows on ONE position — never two positions,
 * and never a second Role invented to hold the second manager.
 *
 * Reads: `cf_hrms_org_view`. Writes: `cf_hrms_org_manage`.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listPositions, getPosition, createPosition, updatePosition, setPositionStatus, deletePosition,
  listPositionContexts, addPositionContext, updatePositionContext, removePositionContext,
  listPositionReporting, addPositionReporting, updatePositionReporting, endPositionReporting, removePositionReporting,
  listPositionOccupants,
  listPositionOverrides, addPositionOverride, removePositionOverride,
  positionOptions,
} from '../services/positionService.js';
import { resolvePositionReporting } from '../services/reportingResolver.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

// Before /positions/:id, or Express would try to read "options" as an id.
router.get('/positions/options', guard(PERM.orgView), handle((req) => positionOptions(pool, ctx(req).companyId)));

router.get('/positions', guard(PERM.orgView), handle((req) => listPositions(pool, ctx(req).companyId, req.query)));
router.post('/positions', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createPosition(db, c, req.body ?? {}))));
router.get('/positions/:id', guard(PERM.orgView), handle((req) => getPosition(pool, ctx(req).companyId, id(req), req.query)));
router.put('/positions/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updatePosition(db, c, id(req), req.body ?? {}))));
router.post('/positions/:id/status', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => setPositionStatus(db, c, id(req), req.body?.status))));
router.delete('/positions/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deletePosition(db, c, id(req)))));

router.get('/positions/:id/work-contexts', guard(PERM.orgView), handle((req) => listPositionContexts(pool, ctx(req).companyId, id(req))));
router.post('/positions/:id/work-contexts', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => addPositionContext(db, c, id(req), req.body ?? {}))));
router.put('/position-work-contexts/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updatePositionContext(db, c, id(req), req.body ?? {}))));
router.delete('/position-work-contexts/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => removePositionContext(db, c, id(req)))));

router.get('/positions/:id/reporting-relationships', guard(PERM.orgView), handle((req) => listPositionReporting(pool, ctx(req).companyId, id(req), req.query)));
router.get('/positions/:id/resolved-reporting', guard(PERM.orgView), handle((req) => resolvePositionReporting(pool, ctx(req).companyId, id(req), req.query)));
router.post('/positions/:id/reporting-relationships', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => addPositionReporting(db, c, id(req), req.body ?? {}))));
router.put('/position-reporting-relationships/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => updatePositionReporting(db, c, id(req), req.body ?? {}))));
router.post('/position-reporting-relationships/:id/end', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => endPositionReporting(db, c, id(req), req.body ?? {}))));
router.delete('/position-reporting-relationships/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => removePositionReporting(db, c, id(req)))));

router.get('/positions/:id/occupants', guard(PERM.orgView), handle((req) => listPositionOccupants(pool, ctx(req).companyId, id(req), req.query)));

router.get('/positions/:id/overrides', guard(PERM.orgView), handle((req) => listPositionOverrides(pool, ctx(req).companyId, id(req))));
router.post('/positions/:id/overrides', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => addPositionOverride(db, c, id(req), req.body ?? {}))));
router.delete('/position-content-overrides/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => removePositionOverride(db, c, id(req)))));

export default router;
