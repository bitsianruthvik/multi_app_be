/**
 * performance.js — performance plans. (TM/CF_HRMS_HIRING_SPEC.md §18.)
 *
 *   GET  /performance/settings                         settings + every role's frequency     performance view or setup view
 *   PUT  /performance/settings                         { yearStartMonth?, defaultFrequency?, ratingScale? }   setup edit
 *   PUT  /performance/role-frequencies                 { roleIds, frequency | null }          setup edit
 *   GET  /performance/periods?year=&frequency=         the periods of a performance year      performance view
 *   POST /performance/periods/:id/close                active plans close with it             performance edit, whole company
 *   POST /performance/plans/preview                    { frequency, start }                   performance edit
 *   POST /performance/plans/create                     { frequency, start, employeeIds? }     performance edit
 *   GET  /performance/plans?periodId=&status=&department=&label=&frequency=&q=               performance view
 *   POST /performance/plans/activate                   { ids }                                performance edit
 *   POST /performance/plans/cancel                     { ids, reason? }                       performance remove
 *   GET  /performance/plans/:id                        one plan, whole                        performance view
 *   POST /performance/plans/:id/activate                                                      performance edit
 *   POST /performance/plans/:id/cancel                 { reason? }                            performance remove
 *   PUT  /performance/plans/:id/kras/:kraId            { weightPercent }        draft         performance edit
 *   POST /performance/plans/:id/kpis                   a KPI added for the period  draft      performance edit
 *   PUT  /performance/plans/:id/kpis/:kpiId            target, unit, weight…    draft         performance edit
 *   DELETE /performance/plans/:id/kpis/:kpiId          removed from the draft (kept)          performance edit
 *   POST /performance/plans/:id/kpis/:kpiId/target     { …target, effectiveFrom?, reason }   active   performance edit
 *   GET  /performance/employees/:id/plans              a person's plans (employee page)       performance view
 *   GET  /performance/employees/:id/scorecard?on=      the org chart panel's KPIs: the plan holding the day
 *                                                      (target, current, achievement, band), else the job's KPIs   performance view
 *
 * ACTUALS (spec §19):
 *   GET  /performance/actuals?periodId=&slot=&department=&label=&role=&manager=&band=&q=&missing=
 *                                                      the Actuals grid: person × KPI for a slot   performance view
 *   PUT  /performance/actuals                          { planId, kpiId, slotStart, value? | met?, note?, reason? }
 *                                                      one cell: enter, or correct with a reason   performance edit
 *   GET  /performance/plans/:id/kpis/:kpiId/actuals    a KPI's actuals, corrections included      performance view
 *   GET  /performance/bands?periodId=                  the org chart's "Colour by performance"     performance view
 *   (Excel: GET/POST /excel/actuals/… — routes/excel.js; the upload needs performance upload.)
 *
 * REVIEWS AND ACTIONS (spec §20):
 *   GET  /performance/reviews?period=&kind=&status=&state=&department=&label=&manager=&q=
 *                                                      check-ins and final reviews (FINALs made when due)  performance view
 *   GET  /performance/reviews/:id                      one review: KPI table, plan score, both parts       performance view
 *   PUT  /performance/reviews/:id                      { managerComment?, rating?, reason? }  — a DONE one: the Owner, with a reason   performance edit
 *   POST /performance/reviews/:id/close                { managerComment?, rating? }  DONE (a FINAL needs its rating)              performance edit
 *   POST /performance/reviews/:id/cancel               { reason? }  a check-in                                                      performance remove
 *   POST /performance/plans/:id/check-ins              { slotStart }                                                                performance edit
 *   GET  /performance/plans/:id/reviews                the plan page's reviews and actions                                          performance view
 *   GET  /performance/actions?status=&overdue=&owner=&period=&department=&label=&manager=&q=
 *                                                      open actions (status=all for every one), overdue first                       performance view
 *   POST /performance/plans/:id/actions                { text, ownerEmployeeId, dueDate, reviewId?, note? }                         performance edit
 *   PUT  /performance/actions/:id                      { text?, ownerEmployeeId?, dueDate?, note? }                                 performance edit
 *   POST /performance/actions/:id/done · /drop         { note? } · { note }                                                         performance edit
 *   GET  /performance/employees/:id/review-summary     the org chart panel: latest rating, open actions                             performance view
 *   (The person's part: /user/me/reviews…; a manager login's: /user/me/team/reviews… — routes/self.js.)
 *
 * Removing a KPI from a DRAFT is part of shaping the draft (edit); removing a
 * PLAN is cancelling it (remove). The department scope (§12.3) applies to every
 * plan: lists are narrowed to it, a plan outside it answers 403 OUT_OF_SCOPE.
 * A manager login's routes are in routes/self.js (/user/me/team/plans…).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, can, step, dateParam } from '../lib/http.js';
import { listed } from '../lib/listFilters.js';
import { notFound } from '../lib/errors.js';
import { inEmployee, companyWide } from '../lib/gates.js';
import { peopleFilter, assertEmployeeInScope } from '../services/accessScope.js';
import { getSettingsPage, saveSettings, setRoleFrequencies } from '../services/performance/settingsService.js';
import {
  listPeriods, closePeriod, previewPlans, createPlans, listPlans, readPlan, planEmployeeId, plansOfEmployee, scorecardOf,
  setKraWeight, addKpi, changeKpi, removeKpi, activatePlan, cancelPlan, forEachPlan, changeTarget,
} from '../services/performance/planService.js';
import { actualsGrid, narrowGrid, enterOne, actualHistory, chartBands } from '../services/performance/actualsService.js';
import {
  listReviews, readReview, reviewEmployeeId, planReviews, openCheckIn, writeManagerPart, closeReview, cancelReview,
  listActions, addAction, changeAction, closeAction, actionEmployeeId, reviewSummary,
} from '../services/performance/reviewService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

/** The plan in the address must be of a person inside the login's department. */
const inPlan = Object.assign(step(async (req) => {
  const employeeId = await planEmployeeId(pool, ctx(req).companyId, intParam(req.params.id));
  if (employeeId != null) await assertEmployeeInScope(req, employeeId);
}), { hrmsStep: 'scope: the person the plan is for' });

const canFor = (req) => ({ edit: can(req, PERM.performance.edit), cancel: can(req, PERM.performance.remove) });

/* ── settings ─────────────────────────────────────────────────────────── */

router.get('/performance/settings', guard([PERM.performance.view, PERM.setup.view]), handle((req) => getSettingsPage(pool, ctx(req).companyId)));
router.put('/performance/settings', guard(PERM.setup.edit), handle((req) => tx(req, (db, c) => saveSettings(db, c, req.body ?? {}))));
router.put('/performance/role-frequencies', guard(PERM.setup.edit), handle((req) => tx(req, (db, c) => setRoleFrequencies(db, c, req.body ?? {}))));

/* ── periods ──────────────────────────────────────────────────────────── */

router.get('/performance/periods', guard(PERM.performance.view, { note: 'narrowed to the login’s department' }), handle(async (req) => (
  listPeriods(pool, ctx(req).companyId, { year: req.query.year, frequency: req.query.frequency }, await peopleFilter(req))
)));
router.post('/performance/periods/:id/close', guard(PERM.performance.edit), companyWide('A period is closed for the whole company, by somebody whose access covers it.'),
  handle((req) => tx(req, (db, c) => closePeriod(db, c, id(req)))));

/* ── making plans ─────────────────────────────────────────────────────── */

router.post('/performance/plans/preview', guard(PERM.performance.edit, { note: 'narrowed to the login’s department' }), handle(async (req) => (
  previewPlans(pool, ctx(req).companyId, req.body ?? {}, await peopleFilter(req))
)));
router.post('/performance/plans/create', guard(PERM.performance.edit, { note: 'narrowed to the login’s department' }), handle(async (req) => {
  const scope = await peopleFilter(req);
  return tx(req, (db, c) => createPlans(db, c, req.body ?? {}, scope));
}));

/* ── the list, and bulk actions ───────────────────────────────────────── */

router.get('/performance/plans', guard(PERM.performance.view, { note: 'narrowed to the login’s department' }), listed('plans'), handle(async (req) => {
  const { items } = await listPlans(pool, ctx(req).companyId, { periodId: req.query.periodId ? intParam(req.query.periodId, 'periodId') : null }, await peopleFilter(req));
  const wantsCancelled = String(req.query.status ?? '').toUpperCase().split(',').includes('CANCELLED');
  return { items: wantsCancelled ? items : items.filter((p) => p.status !== 'CANCELLED') };
}));

const bulk = (fn) => handle((req) => tx(req, (db, c) => forEachPlan(db, c, req.body?.ids, async (planId) => {
  const employeeId = await planEmployeeId(db, c.companyId, planId);
  if (employeeId == null) throw notFound('Plan');
  await assertEmployeeInScope(req, employeeId);
  return fn(db, c, planId, req.body ?? {});
})));
router.post('/performance/plans/activate', guard(PERM.performance.edit, { note: 'scope: each plan’s person' }), bulk((db, c, planId) => activatePlan(db, c, planId)));
router.post('/performance/plans/cancel', guard(PERM.performance.remove, { note: 'scope: each plan’s person' }), bulk((db, c, planId, body) => cancelPlan(db, c, planId, body)));

/* ── one plan ─────────────────────────────────────────────────────────── */

router.get('/performance/plans/:id', guard(PERM.performance.view), inPlan, handle((req) => readPlan(pool, ctx(req).companyId, id(req), canFor(req))));
router.post('/performance/plans/:id/activate', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => activatePlan(db, c, id(req)))));
router.post('/performance/plans/:id/cancel', guard(PERM.performance.remove), inPlan, handle((req) => tx(req, (db, c) => cancelPlan(db, c, id(req), req.body ?? {}))));
router.put('/performance/plans/:id/kras/:kraId', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => setKraWeight(db, c, id(req), intParam(req.params.kraId, 'kraId'), req.body ?? {}))));
router.post('/performance/plans/:id/kpis', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => addKpi(db, c, id(req), req.body ?? {}))));
router.put('/performance/plans/:id/kpis/:kpiId', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => changeKpi(db, c, id(req), intParam(req.params.kpiId, 'kpiId'), req.body ?? {}))));
router.delete('/performance/plans/:id/kpis/:kpiId', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => removeKpi(db, c, id(req), intParam(req.params.kpiId, 'kpiId')))));
router.post('/performance/plans/:id/kpis/:kpiId/target', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => changeTarget(db, c, id(req), intParam(req.params.kpiId, 'kpiId'), req.body ?? {}))));

/* ── actuals (spec §19) ───────────────────────────────────────────────── */

router.get('/performance/actuals', guard(PERM.performance.view, { note: 'narrowed to the login’s department' }), handle(async (req) => {
  const c = ctx(req);
  const grid = await actualsGrid(pool, c.companyId, req.query ?? {}, { scopeDeptIds: await peopleFilter(req), canEnter: can(req, PERM.performance.edit) });
  return narrowGrid(pool, c.companyId, grid, req.query ?? {});
}));

/** The plan named in a body must be of a person inside the login's department. */
const inBodyPlan = Object.assign(step(async (req) => {
  const employeeId = await planEmployeeId(pool, ctx(req).companyId, intParam(req.body?.planId, 'planId'));
  if (employeeId == null) throw notFound('Plan');
  await assertEmployeeInScope(req, employeeId);
}), { hrmsStep: 'scope: the person the plan is for' });

router.put('/performance/actuals', guard(PERM.performance.edit), inBodyPlan, handle((req) => tx(req, (db, c) => enterOne(db, c, req.body ?? {}))));
router.get('/performance/plans/:id/kpis/:kpiId/actuals', guard(PERM.performance.view), inPlan,
  handle((req) => actualHistory(pool, ctx(req).companyId, id(req), intParam(req.params.kpiId, 'kpiId'))));
router.get('/performance/bands', guard(PERM.performance.view, { note: 'narrowed to the login’s department' }), handle(async (req) => (
  chartBands(pool, ctx(req).companyId, { periodId: req.query.periodId ? intParam(req.query.periodId, 'periodId') : null }, await peopleFilter(req))
)));

/* ── reviews and actions (spec §20) ───────────────────────────────────── */

/** The review / action in the address must be of a person inside the login's department. */
const inReview = Object.assign(step(async (req) => {
  const employeeId = await reviewEmployeeId(pool, ctx(req).companyId, intParam(req.params.id));
  if (employeeId != null) await assertEmployeeInScope(req, employeeId);
}), { hrmsStep: 'scope: the person the review is about' });
const inAction = Object.assign(step(async (req) => {
  const employeeId = await actionEmployeeId(pool, ctx(req).companyId, intParam(req.params.id));
  if (employeeId != null) await assertEmployeeInScope(req, employeeId);
}), { hrmsStep: 'scope: the person whose plan the action is on' });
const reviewCanFor = (req) => ({ owner: ctx(req).owner, edit: can(req, PERM.performance.edit), cancel: can(req, PERM.performance.remove) });

router.get('/performance/reviews', guard(PERM.performance.view, { note: 'narrowed to the login’s department' }), listed('reviews'), handle(async (req) => (
  listReviews(pool, ctx(req), { scopeDeptIds: await peopleFilter(req) })
)));
router.get('/performance/reviews/:id', guard(PERM.performance.view), inReview, handle((req) => readReview(pool, ctx(req).companyId, id(req), 'MANAGE', reviewCanFor(req))));
router.put('/performance/reviews/:id', guard(PERM.performance.edit), inReview, handle((req) => tx(req, (db, c) => writeManagerPart(db, c, id(req), req.body ?? {}))));
router.post('/performance/reviews/:id/close', guard(PERM.performance.edit), inReview, handle((req) => tx(req, (db, c) => closeReview(db, c, id(req), req.body ?? {}))));
router.post('/performance/reviews/:id/cancel', guard(PERM.performance.remove), inReview, handle((req) => tx(req, (db, c) => cancelReview(db, c, id(req), req.body ?? {}))));
router.post('/performance/plans/:id/check-ins', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => openCheckIn(db, c, id(req), req.body ?? {}))));
router.get('/performance/plans/:id/reviews', guard(PERM.performance.view), inPlan, handle((req) => planReviews(pool, ctx(req), id(req), 'MANAGE', reviewCanFor(req))));

router.get('/performance/actions', guard(PERM.performance.view, { note: 'narrowed to the login’s department' }), listed('actions'), handle(async (req) => {
  const out = await listActions(pool, ctx(req), { scopeDeptIds: await peopleFilter(req) }, { edit: can(req, PERM.performance.edit) });
  // Open ones unless the address asks for a status (status=all: every one).
  return String(req.query.status ?? '').trim() ? out : { ...out, items: out.items.filter((a) => a.status === 'OPEN') };
}));
router.post('/performance/plans/:id/actions', guard(PERM.performance.edit), inPlan, handle((req) => tx(req, (db, c) => addAction(db, c, id(req), req.body ?? {}))));
router.put('/performance/actions/:id', guard(PERM.performance.edit), inAction, handle((req) => tx(req, (db, c) => changeAction(db, c, id(req), req.body ?? {}))));
router.post('/performance/actions/:id/done', guard(PERM.performance.edit), inAction, handle((req) => tx(req, (db, c) => closeAction(db, c, id(req), 'DONE', req.body ?? {}))));
router.post('/performance/actions/:id/drop', guard(PERM.performance.edit), inAction, handle((req) => tx(req, (db, c) => closeAction(db, c, id(req), 'DROPPED', req.body ?? {}))));
router.get('/performance/employees/:id/review-summary', guard(PERM.performance.view), inEmployee(), handle((req) => reviewSummary(pool, ctx(req).companyId, id(req))));

/* ── a person's plans ─────────────────────────────────────────────────── */

router.get('/performance/employees/:id/plans', guard(PERM.performance.view), inEmployee(), handle((req) => plansOfEmployee(pool, ctx(req).companyId, id(req))));
router.get('/performance/employees/:id/scorecard', guard(PERM.performance.view), inEmployee(),
  handle((req) => scorecardOf(pool, ctx(req).companyId, id(req), { on: dateParam(req.query.on) })));

export default router;
