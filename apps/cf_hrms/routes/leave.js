import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
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
 *   PUT    /leave/policies/:id                  { name?, description?, yearStartsMonth?, status?, rules? } — `rules` REPLACES the set  -> { policy }
 *   DELETE /leave/policies/:id                  409 IN_USE listing where it is assigned
 *   POST   /leave/policies/preview-summary      { rule }  -> { summary, problems } — the sentence as it is typed; writes nothing
 *   GET    /leave/policy-templates              { note, templates }
 *
 *   GET    /leave/assignments                   { company, locations, roles, unassignedPositions }
 *   PUT    /leave/assignments                   { scope, locationId?, roleId?, policyId | null }  -> { assignments }
 *   GET    /leave/policy-for                    ?positionId=  |  ?roleId=&locationId=            -> { effective }
 *
 * Reads: `cf_hrms_leave_view`. Writes: `cf_hrms_leave_manage`. An employee
 * login holds neither; a person reads their OWN policy on `/user/me/place`.
 *
 * STILL TO COME: balances, accrual runs, applying for leave and approvals.
 * Approving a request will write the attendance rows for the affected dates and
 * move the balance, in one transaction — that side effect is why leave is not a
 * standalone list. `/leave/status` below is the stub those screens were wired
 * to, and it still answers "nothing yet" for them.
 */
router.get('/leave/status', guard(PERM.leaveView), handle(async () => ({
  section: 'leave',
  implemented: false,
  phase: 10,
  viewPermission: PERM.leaveView,
  managePermission: PERM.leaveManage,
  items: [],
  total: 0,
  // What IS built: leave types, policies and where they apply.
  policies: true,
})));

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const read = guard(PERM.leaveView);
const write = guard(PERM.leaveManage);

// ── leave types ─────────────────────────────────────────────────────────────
router.get('/leave/types', read, handle((req) => listLeaveTypes(pool, ctx(req).companyId)));
router.post('/leave/types', write, handle((req) => tx(req, (db, c) => createLeaveType(db, c, req.body ?? {}, reqId(req)))));
router.put('/leave/types/:id', write, handle((req) => tx(req, (db, c) => updateLeaveType(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/leave/types/:id', write, handle((req) => tx(req, (db, c) => deleteLeaveType(db, c, id(req), reqId(req)))));

// ── policies ────────────────────────────────────────────────────────────────
router.get('/leave/policy-templates', read, handle(async () => listTemplates()));
router.get('/leave/policies', read, handle((req) => listPolicies(pool, ctx(req).companyId)));
// Before /leave/policies/:id, or "preview-summary" would be read as an id.
router.post('/leave/policies/preview-summary', read, handle((req) => previewRuleSummary(pool, ctx(req).companyId, req.body ?? {})));
router.get('/leave/policies/:id', read, handle((req) => getPolicy(pool, ctx(req).companyId, id(req))));
router.post('/leave/policies', write, handle((req) => tx(req, (db, c) => createPolicy(db, c, req.body ?? {}, reqId(req)))));
router.put('/leave/policies/:id', write, handle((req) => tx(req, (db, c) => updatePolicy(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/leave/policies/:id', write, handle((req) => tx(req, (db, c) => deletePolicy(db, c, id(req), reqId(req)))));

// ── where a policy applies: company default -> location -> role ─────────────
router.get('/leave/assignments', read, handle((req) => getAssignments(pool, ctx(req).companyId)));
router.put('/leave/assignments', write, handle((req) => tx(req, (db, c) => putAssignment(db, c, req.body ?? {}, reqId(req)))));
router.get('/leave/policy-for', read, handle((req) => policyFor(pool, ctx(req).companyId, req.query)));

export default router;
