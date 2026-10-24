/**
 * compliance.js — a company's side of compliance (TM/CF_HRMS_HIRING_SPEC.md §36.4, §36.5;
 * services/compliance/). The product team's console is routes/platform.js (/api/platform/compliance).
 *
 * Rights: the `compliance` area (view: the notices, the calendar, the bell; edit: acknowledge, mark a
 * deadline done). The CA's review: reading needs compliance view; writing (comment, approve, question,
 * sign off) the named right cf_hrms_compliance_review; a calculation trace shows pay, so it needs
 * payroll view and cf_hrms_pay_view too (and is audited). Everything is the whole company's.
 *
 *   GET    /compliance/summary                      the Home card: open notices, deadlines due soon
 *   GET    /compliance/bell                         the bell: open notices and deadlines in the next 3 days
 *   GET    /compliance/notifications                ?status=OPEN|ACKNOWLEDGED|ALL
 *   POST   /compliance/notifications/:id/acknowledge { note? }                                   (edit)
 *   GET    /compliance/calendar                     ?from=&to= — deadlines with their status
 *   POST   /compliance/calendar/done                { key, done: true|false, note? }             (edit)
 *   GET    /compliance/review/sets                  the rule sets in force and their review state
 *   GET    /compliance/review/sets/:set             one set: rules, values, sources, comments
 *   POST   /compliance/review/sets/:set/comments    { action: COMMENT|APPROVE|QUESTION, body?, ruleKey? }  (review)
 *   GET    /compliance/review/changes               what changed since the last sign-off
 *   GET    /compliance/review/runs                  runs for a calculation trace                 (+ payroll view)
 *   GET    /compliance/review/runs/:runId/people    people of a run                              (+ payroll view)
 *   GET    /compliance/review/trace                 ?runId=&employeeId= — every line with its rule version (+ payroll view, pay view; audited)
 *   GET    /compliance/review/signoffs              the yearly sign-offs
 *   POST   /compliance/review/signoffs              { year, note?, withOpenQuestions? }          (review)
 *   GET    /compliance/review/pack                  ?format=xlsx|pdf — the review pack
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, can, dateParam } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { notFound } from '../lib/errors.js';
import { listNotifications, acknowledge } from '../services/compliance/notify.js';
import { deadlinesFor, markDeadline, today, addDays } from '../services/compliance/calendar.js';
import * as REV from '../services/compliance/review.js';
import { reviewPack } from '../services/compliance/reviewPack.js';

const router = Router();
const whole = companyWide('Compliance belongs to the whole company. Your access covers your org unit and everything under it.');
const view = [...guard(PERM.compliance.view), whole];
const edit = [...guard(PERM.compliance.edit), whole];
const review = [...guard(PERM.compliance.view, { also: [PERM.complianceReview] }), whole];
const trace = [...guard(PERM.compliance.view, { also: [PERM.payroll.view, PERM.payView] }), whole];
const runsView = [...guard(PERM.compliance.view, { also: [PERM.payroll.view] }), whole];
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const setParam = (req) => {
  const s = String(req.params.set ?? '').toUpperCase();
  if (!/^[A-Z_]{2,20}:[A-Z]{2}(:\d{4}-\d{2})?$/.test(s)) throw notFound('That rule set');
  return s;
};

/* ── notices, the bell, the Home card ─────────────────────────────── */
router.get('/compliance/summary', ...view, handle(async (req) => {
  const c = ctx(req);
  const { notifications } = await listNotifications(pool, c.companyId, { status: 'OPEN' });
  const cal = await deadlinesFor(pool, c.companyId, { from: addDays(today(), -31), to: addDays(today(), 30) });
  const due = cal.deadlines.filter((d) => d.status === 'OVERDUE' || d.status === 'DUE_SOON' || (d.status === 'UPCOMING' && d.daysLeft <= 10));
  return {
    openNotices: notifications.filter((n) => n.kind === 'LAW_CHANGE').length,
    latest: notifications.filter((n) => n.kind === 'LAW_CHANGE').slice(0, 3),
    due: due.slice(0, 6), overdue: due.filter((d) => d.status === 'OVERDUE').length,
    canAcknowledge: can(req, PERM.compliance.edit),
  };
}));

router.get('/compliance/bell', ...view, handle(async (req) => {
  const c = ctx(req);
  const { notifications } = await listNotifications(pool, c.companyId, { status: 'OPEN', limit: 30 });
  const cal = await deadlinesFor(pool, c.companyId, { from: addDays(today(), -31), to: addDays(today(), 3) });
  const reminded = new Set(notifications.filter((n) => n.kind === 'DEADLINE').map((n) => n.deadlineKey));
  const items = [
    ...notifications.map((n) => ({ id: `n${n.id}`, kind: n.kind, title: n.title, when: n.createdAt, link: n.kind === 'DEADLINE' ? 'compliance?tab=calendar' : `compliance?notice=${n.id}` })),
    ...cal.deadlines.filter((d) => (d.status === 'OVERDUE' || d.status === 'DUE_SOON') && !reminded.has(d.key))
      .map((d) => ({ id: `d${d.key}`, kind: 'DEADLINE', title: `${d.status === 'OVERDUE' ? 'Overdue' : `Due ${d.daysLeft <= 0 ? 'today' : d.daysLeft === 1 ? 'tomorrow' : `in ${d.daysLeft} days`}`} (${d.dueDate}): ${d.title}`, when: d.dueDate, link: 'compliance?tab=calendar' })),
  ];
  return { count: items.length, items };
}));

router.get('/compliance/notifications', ...view, handle(async (req) => {
  const status = ['OPEN', 'ACKNOWLEDGED', 'ALL'].includes(String(req.query.status ?? '').toUpperCase()) ? String(req.query.status).toUpperCase() : 'ALL';
  return { ...(await listNotifications(pool, ctx(req).companyId, { status })), canAcknowledge: can(req, PERM.compliance.edit) };
}));

router.post('/compliance/notifications/:id/acknowledge', ...edit, handle((req) => tx(req, async (db, c) => {
  const n = await acknowledge(db, c, intParam(req.params.id), req.body?.note ?? null);
  if (!n) throw notFound('That notice');
  return { notification: n };
})));

/* ── the deadline calendar ────────────────────────────────────────── */
router.get('/compliance/calendar', ...view, handle(async (req) => {
  const from = req.query.from ? dateParam(req.query.from, 'from') : null;
  const to = req.query.to ? dateParam(req.query.to, 'to') : null;
  return { ...(await deadlinesFor(pool, ctx(req).companyId, { from, to })), canMark: can(req, PERM.compliance.edit) };
}));

router.post('/compliance/calendar/done', ...edit, handle((req) => tx(req, async (db, c) => {
  const d = await markDeadline(db, c, String(req.body?.key ?? '').slice(0, 60), { done: req.body?.done !== false, note: req.body?.note ?? null });
  if (!d) throw notFound('That deadline');
  return { deadline: d };
})));

/* ── the CA's review ──────────────────────────────────────────────── */
router.get('/compliance/review/sets', ...view, handle(async (req) => ({ ...(await REV.ruleSets(pool, ctx(req).companyId)), canReview: can(req, PERM.complianceReview), canTrace: can(req, PERM.payroll.view) && can(req, PERM.payView) })));
router.get('/compliance/review/sets/:set', ...view, handle(async (req) => ({ set: await REV.ruleSetDetail(pool, ctx(req).companyId, setParam(req)), canReview: can(req, PERM.complianceReview) })));
router.post('/compliance/review/sets/:set/comments', ...review, handle((req) => tx(req, async (db, c) => ({ set: await REV.addReviewComment(db, c, setParam(req), req.body ?? {}) }))));
router.get('/compliance/review/changes', ...view, handle((req) => REV.changesSinceSignoff(pool, ctx(req).companyId)));
router.get('/compliance/review/runs', ...runsView, handle(async (req) => ({ runs: await REV.traceRuns(pool, ctx(req).companyId) })));
router.get('/compliance/review/runs/:runId/people', ...runsView, handle(async (req) => ({ people: await REV.tracePeople(pool, ctx(req).companyId, intParam(req.params.runId, 'runId')) })));
router.get('/compliance/review/trace', ...trace, handle((req) => tx(req, (db, c) => REV.calculationTrace(db, c, intParam(req.query.runId, 'runId'), intParam(req.query.employeeId, 'employeeId'), reqId(req)))));
router.get('/compliance/review/signoffs', ...view, handle(async (req) => ({ signoffs: await REV.signoffs(pool, ctx(req).companyId), canSignOff: can(req, PERM.complianceReview) })));
router.post('/compliance/review/signoffs', ...review, handle((req) => tx(req, (db, c) => REV.signOff(db, c, req.body ?? {}))));
router.get('/compliance/review/pack', ...view, handle(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  return reviewPack(pool, ctx(req).companyId, req.query.format === 'pdf' ? 'pdf' : 'xlsx');
}));

export default router;
