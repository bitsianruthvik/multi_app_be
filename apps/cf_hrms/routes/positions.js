/**
 * positions.js — positions, their work contexts, the FORMAL reporting structure
 * and position content overlays. (Plan §5.4, §7.)
 *
 *   GET    /positions/options                          every picker a position form needs, in one request
 *   GET    /positions                     ?on=&status=&roleId=&departmentId=&locationId=&search=
 *                                                      rows + sanctioned/filled/vacant totals over the SAME filtered set
 *   POST   /positions                     { roleId*, positionCode?, positionTitle?, departmentId?, locationId?,
 *                                           defaultShiftId?, status?, effectiveFrom?, effectiveTo? }
 *                                         One position is one chair: sanctionedHeadcount is ignored and stored as 1;
 *                                         defaultShiftId is the position's shift (the company's General shift when absent).
 *                                         Rows carry `shift` {id,code,name} and `occupant` {employeeId,name,employeeCode}|null.
 *   GET    /positions/:id                 ?on=
 *   PUT    /positions/:id                 same fields, all optional. Changing defaultShiftId also moves the person in
 *                                         the position to that shift (their assignment's default shift), same transaction.
 *   POST   /positions/:id/add-sibling     { shiftId? }  one more VACANT position in the same card: same role, title,
 *                                         department, location, status; shift = shiftId or the source's; the source's
 *                                         reporting lines (same-shift manager chair where the manager card has one);
 *                                         no position-level content copied; code = base-<n>, lowest free n >= 2.
 *                                         Returns what POST /positions returns: { asOf, position }.
 *   POST   /positions/:id/status          { status }   DRAFT / ACTIVE / FROZEN / CLOSED  (CLOSED refused with HAS_TEAM when the seat has
 *                                         direct reports: use /close, which moves them up. Same for PUT with status CLOSED.)
 *   GET    /positions/:id/delete-impact   what closing / deleting alone / deleting with the team would each do,
 *                                         and whether each is allowed — read BEFORE confirming
 *   POST   /positions/:id/close           { expect? }  keeps the seat and its history; its direct reports move to another
 *                                         position of the same card, or UP to its manager when it is the card's last one
 *   DELETE /positions/:id                 ?mode=THIS_ONLY|WITH_TEAM&expect=N
 *                                         THIS_ONLY: the seat goes, its direct reports move (same rule as close:
 *                                                    the card's other positions first, up only from its last one)
 *                                         WITH_TEAM: the seat and everyone under it go
 *                                         `mode` is required when the seat has direct reports; `expect` is the
 *                                         number the person saw (reports moved / positions deleted) and a
 *                                         different answer is refused as IMPACT_CHANGED. Refused while anyone is
 *                                         assigned to a seat that would go, and — for THIS_ONLY and close — when
 *                                         the seat has reports but no open position above it to receive them.
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
 *   GET    /positions/:id/job-content     ?on=   the seat's RESOLVED KRAs, responsibilities and KPIs (role + this
 *                                         seat's changes), every line marked ADDED / CHANGED / OFF or unmarked
 *   POST   /positions/:id/job-content/add         { kind: RESPONSIBILITY|KPI, text, parentKraDefinitionId?, target?, reason? }
 *   POST   /positions/:id/job-content/change      { kind, definitionId, text?, target?: { operator?, value }, reason? }
 *   POST   /positions/:id/job-content/switch-off  { kind, definitionId, reason? }
 *   POST   /positions/:id/job-content/undo        { kind, definitionId }   back to what the role says
 *                                         The four writes are override rows underneath (services/jobContentService.js)
 *                                         and each answers with the job content after the edit. A KRA is refused:
 *                                         KRAs are fixed at the role.
 *
 * MULTIPLE REPORTING ROWS PER POSITION ARE NORMAL (v1.1 §13.1). A primary line
 * plus a scoped dotted line is two rows on ONE position — never two positions,
 * and never a second Role invented to hold the second manager.
 *
 * Reads: `cf_hrms_org_view`. Writes: `cf_hrms_org_manage`.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, dateParam } from '../lib/http.js';
import {
  listPositions, getPosition, createPosition, updatePosition, addSiblingPosition, setPositionStatus, deletePosition, closePosition, getDeleteImpact, refuseCloseWithTeam,
  listPositionContexts, addPositionContext, updatePositionContext, removePositionContext,
  listPositionReporting, addPositionReporting, updatePositionReporting, endPositionReporting, removePositionReporting,
  listPositionOccupants,
  listPositionOverrides, addPositionOverride, removePositionOverride,
  positionOptions,
} from '../services/positionService.js';
import { resolvePositionReporting } from '../services/reportingResolver.js';
import {
  positionJobContent, seatAddLine, seatChangeLine, seatSwitchOffLine, seatUndoLine,
} from '../services/jobContentService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

// Before /positions/:id, or Express would try to read "options" as an id.
router.get('/positions/options', guard(PERM.orgView), handle((req) => positionOptions(pool, ctx(req).companyId)));

router.get('/positions', guard(PERM.orgView), handle((req) => listPositions(pool, ctx(req).companyId, req.query)));
router.post('/positions', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => createPosition(db, c, req.body ?? {}))));
router.get('/positions/:id', guard(PERM.orgView), handle((req) => getPosition(pool, ctx(req).companyId, id(req), req.query)));
router.put('/positions/:id', guard(PERM.orgManage), handle((req) => tx(req, async (db, c) => {
  // CLOSED set directly would orphan the seat's team in the chart; see refuseCloseWithTeam.
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'status')) await refuseCloseWithTeam(db, c.companyId, id(req), req.body.status);
  return updatePosition(db, c, id(req), req.body ?? {});
})));
router.post('/positions/:id/status', guard(PERM.orgManage), handle((req) => tx(req, async (db, c) => {
  await refuseCloseWithTeam(db, c.companyId, id(req), req.body?.status);
  return setPositionStatus(db, c, id(req), req.body?.status);
})));
// One more chair in the same card. Creating a position, so the same permission as POST /positions.
router.post('/positions/:id/add-sibling', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => addSiblingPosition(db, c, id(req), req.body ?? {}))));
router.get('/positions/:id/delete-impact', guard(PERM.orgView), handle((req) => getDeleteImpact(pool, ctx(req).companyId, id(req))));
router.post('/positions/:id/close', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => closePosition(db, c, id(req), { expect: req.body?.expect }))));
router.delete('/positions/:id', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => deletePosition(db, c, id(req), { mode: req.query.mode, expect: req.query.expect }))));

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

// ----- the seat's job content, and its plain-language edits -------------------
// The read is org_view, like every other read of a seat. The four writes are
// org_manage — the tag the override endpoints above already ask for, because
// that is what they write. cf_hrms_self_view reaches none of the five.
router.get('/positions/:id/job-content', guard(PERM.orgView), handle((req) => positionJobContent(pool, ctx(req).companyId, id(req), { on: dateParam(req.query.on) })));
router.post('/positions/:id/job-content/add', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => seatAddLine(db, c, id(req), req.body ?? {}))));
router.post('/positions/:id/job-content/change', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => seatChangeLine(db, c, id(req), req.body ?? {}))));
router.post('/positions/:id/job-content/switch-off', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => seatSwitchOffLine(db, c, id(req), req.body ?? {}))));
router.post('/positions/:id/job-content/undo', guard(PERM.orgManage), handle((req) => tx(req, (db, c) => seatUndoLine(db, c, id(req), req.body ?? {}))));

export default router;
