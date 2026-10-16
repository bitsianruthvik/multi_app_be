/**
 * self.js — the employee self view. Two endpoints, one permission, no ids.
 *
 *   GET /user/me/place      ?on=YYYY-MM-DD   gated on `cf_hrms_self_view`
 *   GET /user/me/orgchart   ?on=YYYY-MM-DD   gated on `cf_hrms_self_view` (2026-10-09)
 *
 * It sits under `/user/` to match the platform's own URL shape
 * (`/api/:companySlug/:appSlug/user/*` is "authenticated user endpoints" —
 * CLAUDE.md), and `me` rather than `:id` is the whole security design: there is
 * no identifier in this path, so there is nothing for a caller to substitute.
 * The employee is found by `req.user.id` → `hrms_employees.user_id`.
 *
 * ── THIS FILE ONLY EVER ANSWERS ABOUT "ME" ────────────────────────────────
 * `cf_hrms_self_view` is the only tag a shop-floor login holds, and the only
 * thing it may ever buy is the caller's own place in the organisation. The
 * second route, `/me/orgchart`, is that same place drawn as a chart: the
 * caller's managers up to the top, their own seats, their branch below and
 * their dotted-line managers — computed server-side from the caller's own
 * seats, field-whitelisted, never the whole graph (selfOrgChartService.js).
 * It takes no id either. Every other useful-sounding addition breaks the rule:
 *
 *   - a `?employeeId=` parameter turns it into a people directory;
 *   - a "my team's attendance" route turns it into the attendance screen with
 *     a different gate, which is what `cf_hrms_attendance_view` is for;
 *   - a lookup by employee code is the same disclosure with extra steps.
 *
 * A supervisor who genuinely needs their team's attendance gets
 * `cf_hrms_attendance_view` granted to their role. That is the mechanism; this
 * is not.
 *
 * ── PII ───────────────────────────────────────────────────────────────────
 * `canSeePii` is passed in as a SHAPE decision, not an access decision — the
 * same pattern `people.js` uses. Without `cf_hrms_people_pii` the caller still
 * gets a complete answer, with their own contact details (their own data) and
 * everybody else as a name and a job. Statutory identifiers are not in this
 * payload at any permission level; `people.js` is the sole read path for those
 * and it audits every unmasked read.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, dateParam, canSeePii, intParam, can } from '../lib/http.js';
import { scopeOf } from '../services/accessScope.js';
import {
  myLeave, previewMine, submitMine, cancelMine, myApprovals, approvalDetail, decide, employeeIdOfLogin,
} from '../services/leave/requestService.js';
import { myPlace } from '../services/selfService.js';
import { myOrgChart } from '../services/selfOrgChartService.js';
import {
  teamJobContent, teamAddLine, teamChangeLine, teamSwitchOffLine, teamUndoLine, teamShifts, teamChangeShift,
  teamPersonJobContent, teamPersonAddLine, teamPersonChangeLine, teamPersonSwitchOffLine, teamPersonUndoLine,
  teamPlans, teamPlan, teamScorecard, teamSetKraWeight, teamAddKpi, teamChangeKpi, teamRemoveKpi,
  teamActuals, teamEnterActual, teamActualHistory,
  teamReviews, teamReview, teamWriteReview, teamCloseReview, teamCancelReview, teamOpenCheckIn, teamPlanReviews, teamAddAction, teamChangeAction, teamCloseAction,
} from '../services/teamScopeService.js';
import { myPlans, myActualHistory, myScorecard } from '../services/performance/planService.js';
import { myReviews, myReview, writeMyPart, finishMyPart, markMyActionDone } from '../services/performance/reviewService.js';

const router = Router();

/**
 * Who I am, who I report into, who is on my team, what I am responsible for.
 *
 * `on` exists because every read in this app is "as of a date" — a person
 * looking at their place last month is a fair question and the resolvers all
 * take it. It changes which effective-dated rows resolve; it cannot change
 * WHOSE rows they are.
 */
router.get('/user/me/place', guard(PERM.selfView), handle((req) => myPlace(
  pool,
  ctx(req),
  { on: dateParam(req.query.on), canSeePii: canSeePii(req) },
)));

/**
 * My slice of the org chart. The company graph is read server-side and cut to
 * the caller's slice before anything leaves; `/orgchart` itself stays on
 * `cf_hrms_org_view`, and this tag must never be added to its guard.
 */
router.get('/user/me/orgchart', guard(PERM.selfView), handle((req) => myOrgChart(
  pool,
  ctx(req),
  { on: dateParam(req.query.on) },
)));

/**
 * WHAT AN EMPLOYEE LOGIN MAY CHANGE (spec §7): for the positions BELOW them —
 * and for no other — the position's responsibilities and KPIs, and its shift.
 *
 *   GET    /user/me/team/positions/:id/job-content            = GET  /positions/:id/job-content
 *   POST   /user/me/team/positions/:id/job-content/add        = POST /positions/:id/job-content/add
 *   POST   /user/me/team/positions/:id/job-content/change       …/change
 *   POST   /user/me/team/positions/:id/job-content/switch-off   …/switch-off
 *   POST   /user/me/team/positions/:id/job-content/undo         …/undo
 *   GET    /user/me/team/shifts                               { shifts: [{ id, code, name, summary }] }
 *   PUT    /user/me/team/positions/:id/shift  { shiftId }     = PUT  /positions/:id with defaultShiftId only
 *
 * Gated on the one self tag, like everything in this file — and then on THE
 * RULE, which services/teamScopeService.js runs on every call from the
 * caller's own employee and position (never from anything the client sends):
 * outside it, 403 NOT_YOUR_TEAM. Each write calls the same service function the
 * HR route calls, so validation, the KRA refusal and the audit row are the same.
 */
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const positionId = (req) => intParam(req.params.id);

router.get('/user/me/team/shifts', guard(PERM.selfView), handle((req) => teamShifts(pool, ctx(req))));
router.get('/user/me/team/positions/:id/job-content', guard(PERM.selfView), handle((req) => (
  teamJobContent(pool, ctx(req), positionId(req), { on: dateParam(req.query.on) })
)));
router.post('/user/me/team/positions/:id/job-content/add', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamAddLine(db, c, positionId(req), req.body ?? {}))));
router.post('/user/me/team/positions/:id/job-content/change', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamChangeLine(db, c, positionId(req), req.body ?? {}))));
router.post('/user/me/team/positions/:id/job-content/switch-off', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamSwitchOffLine(db, c, positionId(req), req.body ?? {}))));
router.post('/user/me/team/positions/:id/job-content/undo', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamUndoLine(db, c, positionId(req), req.body ?? {}))));
// Spec §16.2: a manager login changes the job of a PERSON below them, like a position below them.
router.get('/user/me/team/employees/:id/job-content', guard(PERM.selfView), handle((req) => (
  teamPersonJobContent(pool, ctx(req), intParam(req.params.id), { on: dateParam(req.query.on) }))));
router.post('/user/me/team/employees/:id/job-content/add', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamPersonAddLine(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/employees/:id/job-content/change', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamPersonChangeLine(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/employees/:id/job-content/switch-off', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamPersonSwitchOffLine(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/employees/:id/job-content/undo', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamPersonUndoLine(db, c, intParam(req.params.id), req.body ?? {}))));
router.put('/user/me/team/positions/:id/shift', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamChangeShift(db, c, positionId(req), req.body ?? {}))));

/**
 * PERFORMANCE PLANS (spec §18). My own plan, read-only: GET /user/me/plan (no id —
 * the plan is found from my login). A manager login may view and edit the DRAFT
 * plans of the people below them — the same rule as their jobs (assertPersonInMyTeam):
 * never their own plan, a card-mate's or a manager's. They do not activate or cancel.
 */
router.get('/user/me/plan', guard(PERM.selfView), handle((req) => myPlans(pool, ctx(req))));
// My KPIs at a glance (My place) — the same read as the org chart panel's, for the login's own employee.
router.get('/user/me/scorecard', guard(PERM.selfView), handle((req) => myScorecard(pool, ctx(req), { on: dateParam(req.query.on) })));
router.get('/user/me/team/plans', guard(PERM.selfView), handle((req) => teamPlans(pool, ctx(req))));
router.get('/user/me/team/plans/:id', guard(PERM.selfView), handle((req) => teamPlan(pool, ctx(req), intParam(req.params.id))));
// The chart panel's KPIs of whoever sits in a position below me (= GET /performance/employees/:id/scorecard).
router.get('/user/me/team/positions/:id/scorecard', guard(PERM.selfView), handle((req) => teamScorecard(pool, ctx(req), intParam(req.params.id), { on: dateParam(req.query.on) })));
router.put('/user/me/team/plans/:id/kras/:kraId', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamSetKraWeight(db, c, intParam(req.params.id), intParam(req.params.kraId, 'kraId'), req.body ?? {}))));
router.post('/user/me/team/plans/:id/kpis', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamAddKpi(db, c, intParam(req.params.id), req.body ?? {}))));
router.put('/user/me/team/plans/:id/kpis/:kpiId', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamChangeKpi(db, c, intParam(req.params.id), intParam(req.params.kpiId, 'kpiId'), req.body ?? {}))));
/*
 * ACTUALS (spec §19.2). My own actuals are read on My plan (above, read-only; a KPI's
 * corrections through the history route). A manager login enters actuals for the
 * people below them — the same rule, the same writer as HR's PUT /performance/actuals.
 */
router.get('/user/me/plan/:id/kpis/:kpiId/actuals', guard(PERM.selfView), handle((req) => myActualHistory(pool, ctx(req), intParam(req.params.id), intParam(req.params.kpiId, 'kpiId'))));
router.get('/user/me/team/actuals', guard(PERM.selfView), handle((req) => teamActuals(pool, ctx(req), req.query ?? {})));
router.put('/user/me/team/actuals', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamEnterActual(db, c, req.body ?? {}))));
router.get('/user/me/team/plans/:id/kpis/:kpiId/actuals', guard(PERM.selfView), handle((req) => teamActualHistory(pool, ctx(req), intParam(req.params.id), intParam(req.params.kpiId, 'kpiId'))));
router.delete('/user/me/team/plans/:id/kpis/:kpiId', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamRemoveKpi(db, c, intParam(req.params.id), intParam(req.params.kpiId, 'kpiId')))));

/**
 * REVIEWS AND ACTIONS (spec §20.2).
 *
 * THE PERSON — the first place an employee login WRITES anything, and exactly this:
 * their own comment and blockers on their own OPEN review, "my part is done", and
 * "done" on an action they own. The review / action is found from the login
 * (another person's reads as not found); every other field is refused by name
 * (reviewService onlyFields) — checked on the server, field by field.
 *
 * A MANAGER LOGIN — for the people below them (the same rule as their plans):
 * open a check-in, write the manager's part, rate, close, cancel a check-in; add,
 * change, mark done and drop actions. Never on their own review.
 */
router.get('/user/me/reviews', guard(PERM.selfView), handle((req) => myReviews(pool, ctx(req))));
router.get('/user/me/reviews/:id', guard(PERM.selfView), handle((req) => myReview(pool, ctx(req), intParam(req.params.id))));
router.put('/user/me/reviews/:id', guard(PERM.selfView), handle((req) => tx(req, (db, c) => writeMyPart(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/reviews/:id/done', guard(PERM.selfView), handle((req) => tx(req, (db, c) => finishMyPart(db, c, intParam(req.params.id)))));
router.post('/user/me/actions/:id/done', guard(PERM.selfView), handle((req) => tx(req, (db, c) => markMyActionDone(db, c, intParam(req.params.id), req.body ?? {}))));

router.get('/user/me/team/reviews', guard(PERM.selfView), handle((req) => teamReviews(pool, ctx(req))));
router.get('/user/me/team/reviews/:id', guard(PERM.selfView), handle((req) => teamReview(pool, ctx(req), intParam(req.params.id))));
router.put('/user/me/team/reviews/:id', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamWriteReview(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/reviews/:id/close', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamCloseReview(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/reviews/:id/cancel', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamCancelReview(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/plans/:id/check-ins', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamOpenCheckIn(db, c, intParam(req.params.id), req.body ?? {}))));
router.get('/user/me/team/plans/:id/reviews', guard(PERM.selfView), handle((req) => teamPlanReviews(pool, ctx(req), intParam(req.params.id))));
router.post('/user/me/team/plans/:id/actions', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamAddAction(db, c, intParam(req.params.id), req.body ?? {}))));
router.put('/user/me/team/actions/:id', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamChangeAction(db, c, intParam(req.params.id), req.body ?? {}))));
router.post('/user/me/team/actions/:id/done', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamCloseAction(db, c, intParam(req.params.id), 'DONE', req.body ?? {}))));
router.post('/user/me/team/actions/:id/drop', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamCloseAction(db, c, intParam(req.params.id), 'DROPPED', req.body ?? {}))));

/**
 * LEAVE (spec §22.5). My own leave — the employee is the login's, never an id from the
 * client; a request id in the address is only what is asked about, and another person's
 * reads as not found.
 *
 *   GET  /user/me/leave?year=                 { year, policy, balances, requests, approver, calendarNote }
 *   POST /user/me/leave/preview               { leaveTypeId, from, to, halfDay? }  -> Preview (writes nothing)
 *   POST /user/me/leave                       the same + reason  -> { request } · 422 INVALID with problems
 *   POST /user/me/leave/:id/cancel            { note? }  -> { request }
 */
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
router.get('/user/me/leave', guard(PERM.selfView), handle((req) => myLeave(pool, ctx(req), { year: req.query.year })));
router.post('/user/me/leave/preview', guard(PERM.selfView), handle((req) => previewMine(pool, ctx(req), req.body ?? {})));
router.post('/user/me/leave', guard(PERM.selfView), handle((req) => tx(req, (db, c) => submitMine(db, c, req.body ?? {}, reqId(req)))));
router.post('/user/me/leave/:id/cancel', guard(PERM.selfView), handle((req) => tx(req, (db, c) => cancelMine(db, c, intParam(req.params.id), req.body ?? {}, reqId(req)))));

/**
 * APPROVALS — everything waiting for this login to decide, of every kind.
 *
 *   GET  /user/me/approvals?status=PENDING|DECIDED     { items: ApprovalItem[], counts: { pending } }
 *   GET  /user/me/approvals/<kind>/:id                 { request, context }
 *   POST /user/me/approvals/<kind>/:id/approve         { note? }  -> { request }
 *   POST /user/me/approvals/<kind>/:id/reject          { note }   -> { request }
 *
 * Who may decide is the service's rule (the approver, anybody above them in the chain,
 * or a login with leave edit inside its department scope; never their own). Leave edit
 * here changes WHAT is waiting for the login, not whether the route opens: the route
 * asks for the self view only, like every /user/me route.
 *
 * ONE ENTRY PER KIND. Today only `leave`. Another kind of approval adds an entry —
 * its feed, its read and its decide — and the list, the counts and the routes follow.
 */
async function viewerOf(req) {
  const c = ctx(req);
  let hr = null;
  if (can(req, PERM.leave.edit)) {
    const scope = await scopeOf(req);
    hr = scope.all ? { all: true } : { departmentIds: scope.departmentIds };
  }
  return { userId: c.userId, employeeId: await employeeIdOfLogin(pool, c), hr };
}
const APPROVAL_KINDS = {
  leave: {
    feed: (c, viewer, status) => myApprovals(pool, c, viewer, { status }),
    read: (c, viewer, itemId) => approvalDetail(pool, c, viewer, itemId),
    decide: (db, c, viewer, itemId, verdict, body, requestId) => decide(db, c, viewer, itemId, verdict, body, requestId),
  },
};
router.get('/user/me/approvals', guard(PERM.selfView), handle(async (req) => {
  const c = ctx(req);
  const viewer = await viewerOf(req);
  const status = String(req.query.status ?? 'PENDING').toUpperCase() === 'DECIDED' ? 'DECIDED' : 'PENDING';
  const feeds = await Promise.all(Object.values(APPROVAL_KINDS).map((k) => k.feed(c, viewer, status)));
  const items = feeds.flatMap((f) => f.items).sort((a, b) => (status === 'PENDING' ? String(a.submittedAt).localeCompare(String(b.submittedAt)) : 0));
  return { items, counts: { pending: feeds.reduce((s, f) => s + f.counts.pending, 0) } };
}));
for (const [kind, k] of Object.entries(APPROVAL_KINDS)) {
  router.get(`/user/me/approvals/${kind}/:id`, guard(PERM.selfView), handle(async (req) => k.read(ctx(req), await viewerOf(req), intParam(req.params.id))));
  for (const [path, verdict] of [['approve', 'APPROVE'], ['reject', 'REJECT']]) {
    router.post(`/user/me/approvals/${kind}/:id/${path}`, guard(PERM.selfView), handle(async (req) => {
      const viewer = await viewerOf(req);
      return tx(req, (db, c) => k.decide(db, c, viewer, intParam(req.params.id), verdict, req.body ?? {}, reqId(req)));
    }));
  }
}

export default router;
