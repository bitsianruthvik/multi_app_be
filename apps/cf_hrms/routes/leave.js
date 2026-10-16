import { Router } from 'express';
import { listed } from '../lib/listFilters.js';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, need, can } from '../lib/http.js';
import { companyWide, inEmployee } from '../lib/gates.js';
import { peopleFilter } from '../services/accessScope.js';
import {
  listRequests, readRequest, previewForPerson, submitForPerson, decide, cancelByHr, balancesGrid, setOpening, employeeIdOfLogin,
} from '../services/leave/requestService.js';
import {
  listLeaveTypes, createLeaveType, updateLeaveType, deleteLeaveType,
  listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy, listTemplates, previewRuleSummary,
  getAssignments, putAssignment, policyFor,
} from '../services/leavePolicyService.js';

const router = Router();

/**
 * cf_hrms — leave routes (plan §7; leave policies: CF_HRMS_HIRING_SPEC.md §8).
 *
 * BUILT SO FAR — the definition of leave, not the taking of it:
 *
 *   GET    /leave/types                         { types }
 *   POST   /leave/types                         { code, name, unit?, isPaid?, status? }   -> { type }
 *   PUT    /leave/types/:id                                                               -> { type }
 *   DELETE /leave/types/:id                     409 IN_USE while a policy grants it
 *
 *   GET    /leave/policies                      { policies: PolicySummary[] }
 *   GET    /leave/policies/:id                  { policy: Policy }
 *   POST   /leave/policies                      { name, code?, description?, yearStartsMonth?, status?, fromTemplate?, copyOf? }  -> { policy }
 *   PUT    /leave/policies/:id                  { name?, description?, yearStartsMonth?, effectiveFrom?, status?, rules? } — `rules` REPLACES the set  -> { policy }
 *   DELETE /leave/policies/:id                  409 IN_USE listing where it is assigned
 *   POST   /leave/policies/preview-summary      { rule }  -> { summary, problems } — the sentence as it is typed; writes nothing
 *   GET    /leave/policy-templates              { note, templates }
 *
 *   GET    /leave/assignments                   { company, locations, labels, roles, unassignedPositions }
 *   PUT    /leave/assignments                   { scope, locationId?, roleId?, labelId?, policyId | null }  -> { assignments }
 *   GET    /leave/policy-for                    ?positionId=  |  ?roleId=&locationId=&departmentId=  -> { effective }
 *
 * REQUESTS AND BALANCES (spec §22.5; services/leave/). Department scope as elsewhere:
 * lists are narrowed to the login's departments, one request or person outside them
 * answers 403 OUT_OF_SCOPE.
 *
 *   GET    /leave/requests                      ?status=&leaveTypeId=&departmentId=&from=&to=&q=   -> { items: Request[], total }
 *   GET    /leave/requests/:id                  { request, context }
 *   POST   /leave/requests/preview              { employeeId, leaveTypeId, from, to, halfDay? }      -> Preview
 *   POST   /leave/requests                      the same + reason, on the person's behalf (raised by HR) -> { request }
 *   POST   /leave/requests/:id/approve          { note? }   -> { request }
 *   POST   /leave/requests/:id/reject           { note }    -> { request }
 *   POST   /leave/requests/:id/cancel           { note }    -> { request }   any time, with a note
 *   GET    /leave/balances                      ?year=&departmentId=&q=  -> { year, leaveTypes, rows: [{ person, policy, year, balances }] }
 *   PUT    /leave/balances                      { employeeId, leaveTypeId, yearKey, opening, note }  -> { balance, yearKey }
 *                                               opening: null clears HR's number (also needs leave remove)
 *   (Excel: GET/POST /excel/leave-balances/… — routes/excel.js; the upload needs leave edit.)
 *   (A person's own leave and the approvals screen: /user/me/leave…, /user/me/approvals… — routes/self.js.)
 *
 * Reads: `cf_hrms_leave_view`. Writes: `cf_hrms_leave_edit`; deletes: `cf_hrms_leave_remove`. An employee
 * login holds neither; a person reads their OWN policy on `/user/me/place`.
 *
 * No attendance rows are written on approval: attendance is not built. A balance is
 * computed on every read (services/leave/balance.js), so approving or cancelling moves
 * it without writing it. `/leave/status` below is the old stub; it stays for a screen
 * that still asks it.
 */
router.get('/leave/status', guard(PERM.leave.view), handle(async () => ({
  section: 'leave',
  implemented: false,
  phase: 10,
  viewPermission: PERM.leave.view,
  managePermission: PERM.leave.edit,
  items: [],
  total: 0,
  // What IS built: leave types, policies and where they apply.
  policies: true,
})));

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;

// ── leave types ─────────────────────────────────────────────────────────────
router.get('/leave/types', guard(PERM.leave.view), handle((req) => listLeaveTypes(pool, ctx(req).companyId)));
router.post('/leave/types', guard(PERM.leave.edit), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle((req) => tx(req, (db, c) => createLeaveType(db, c, req.body ?? {}, reqId(req)))));
router.put('/leave/types/:id', guard(PERM.leave.edit), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle((req) => tx(req, (db, c) => updateLeaveType(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/leave/types/:id', guard(PERM.leave.remove), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle((req) => tx(req, (db, c) => deleteLeaveType(db, c, id(req), reqId(req)))));

// ── policies ────────────────────────────────────────────────────────────────
router.get('/leave/policy-templates', guard(PERM.leave.view), handle(async () => listTemplates()));
router.get('/leave/policies', guard(PERM.leave.view), listed('leavePolicies'), handle((req) => listPolicies(pool, ctx(req).companyId)));
// Before /leave/policies/:id, or "preview-summary" would be read as an id.
router.post('/leave/policies/preview-summary', guard(PERM.leave.view), handle((req) => previewRuleSummary(pool, ctx(req).companyId, req.body ?? {})));
router.get('/leave/policies/:id', guard(PERM.leave.view), handle((req) => getPolicy(pool, ctx(req).companyId, id(req))));
router.post('/leave/policies', guard(PERM.leave.edit), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle((req) => tx(req, (db, c) => createPolicy(db, c, req.body ?? {}, reqId(req)))));
router.put('/leave/policies/:id', guard(PERM.leave.edit, { note: 'archiving it, or saving it without a leave type it had, also needs cf_hrms_leave_remove' }), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle(async (req) => {
  // Archiving a policy, and taking a leave type out of one, are removals.
  if (String(req.body?.status ?? '').toUpperCase() === 'ARCHIVED') need(req, PERM.leave.remove);
  if (Array.isArray(req.body?.rules)) {
    const [had] = await pool.query('SELECT leave_type_id FROM hrms_leave_policy_rules WHERE company_id = ? AND policy_id = ? AND deleted_at IS NULL', [ctx(req).companyId, id(req)]);
    const kept = new Set(req.body.rules.map((r) => Number(r?.leaveTypeId)));
    if (had.some((r) => !kept.has(r.leave_type_id))) need(req, PERM.leave.remove);
  }
  return tx(req, (db, c) => updatePolicy(db, c, id(req), req.body ?? {}, reqId(req)));
}));
router.delete('/leave/policies/:id', guard(PERM.leave.remove), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle((req) => tx(req, (db, c) => deletePolicy(db, c, id(req), reqId(req)))));

// ── where a policy applies: company default -> location -> label -> role (spec §17) ──
router.get('/leave/assignments', guard(PERM.leave.view), handle((req) => getAssignments(pool, ctx(req).companyId)));
router.put('/leave/assignments', guard(PERM.leave.edit, { note: 'clearing one (policyId: null) also needs cf_hrms_leave_remove' }), companyWide('This belongs to the whole company. Your access covers your own department only.'), handle((req) => {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'policyId') && (req.body.policyId === null || req.body.policyId === '')) need(req, PERM.leave.remove);
  return tx(req, (db, c) => putAssignment(db, c, req.body ?? {}, reqId(req)));
}));
router.get('/leave/policy-for', guard(PERM.leave.view), handle((req) => policyFor(pool, ctx(req).companyId, req.query)));

// ── requests (spec §22.5) ───────────────────────────────────────────────────
/** Who is acting: their own employee (nobody decides their own leave) and whether they hold leave edit. */
const viewerOf = async (req) => ({ userId: ctx(req).userId, employeeId: await employeeIdOfLogin(pool, ctx(req)), hr: can(req, PERM.leave.edit) ? { all: true } : null });
const inRequest = inEmployee('leaveRequest');
const inBodyPerson = inEmployee('employee', (req) => req.body?.employeeId);

router.get('/leave/requests', guard(PERM.leave.view, { note: 'narrowed to the login’s department' }), handle(async (req) => (
  listRequests(pool, ctx(req), req.query ?? {}, await peopleFilter(req), await viewerOf(req)))));
// Before /leave/requests/:id, or "preview" would be read as an id.
router.post('/leave/requests/preview', guard(PERM.leave.edit), inBodyPerson, handle((req) => previewForPerson(pool, ctx(req), req.body ?? {})));
router.post('/leave/requests', guard(PERM.leave.edit), inBodyPerson, handle(async (req) => {
  const viewer = await viewerOf(req);
  return tx(req, (db, c) => submitForPerson(db, c, req.body ?? {}, viewer, reqId(req)));
}));
router.get('/leave/requests/:id', guard(PERM.leave.view), inRequest, handle(async (req) => readRequest(pool, ctx(req), await viewerOf(req), id(req))));
router.post('/leave/requests/:id/approve', guard(PERM.leave.edit), inRequest, handle(async (req) => {
  const viewer = await viewerOf(req);
  return tx(req, (db, c) => decide(db, c, viewer, id(req), 'APPROVE', req.body ?? {}, reqId(req)));
}));
router.post('/leave/requests/:id/reject', guard(PERM.leave.edit), inRequest, handle(async (req) => {
  const viewer = await viewerOf(req);
  return tx(req, (db, c) => decide(db, c, viewer, id(req), 'REJECT', req.body ?? {}, reqId(req)));
}));
router.post('/leave/requests/:id/cancel', guard(PERM.leave.edit), inRequest, handle(async (req) => {
  const viewer = await viewerOf(req);
  return tx(req, (db, c) => cancelByHr(db, c, id(req), req.body ?? {}, viewer, reqId(req)));
}));

// ── balances: the person × type grid, and HR's opening balance ──────────────
router.get('/leave/balances', guard(PERM.leave.view, { note: 'narrowed to the login’s department' }), handle(async (req) => (
  balancesGrid(pool, ctx(req), req.query ?? {}, await peopleFilter(req)))));
router.put('/leave/balances', guard(PERM.leave.edit, { note: 'clearing one (opening: null) also needs cf_hrms_leave_remove' }), inBodyPerson, handle((req) => {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'opening') && (req.body.opening === null || req.body.opening === '')) need(req, PERM.leave.remove);
  return tx(req, (db, c) => setOpening(db, c, req.body ?? {}, reqId(req)));
}));

export default router;
