/**
 * routes/complianceChecks.js — compliance checks, to-dos with a proposed fix, the bonus run
 * (TM/CF_HRMS_HIRING_SPEC.md §36.2, §36.3, C2; services/complianceChecks/*).
 *
 *   GET  /payroll/runs/:id/compliance                 the run's compliance panel: every breach per person; canLock
 *   POST /payroll/runs/:id/compliance/acknowledge     { reason, items?: [{ employeeId, check, ruleId }] } — WARNs accepted
 *   GET  /payroll/compliance-todos/summary            { counts } (the Home card; no amounts)
 *   GET  /payroll/compliance-todos?status=open|done|all
 *   POST /payroll/compliance-todos/check-now          runs findBreaches now → to-dos created / updated / resolved
 *   GET  /payroll/compliance-todos/:id                the to-do, people, structures, the fixes with before / after
 *   POST /payroll/compliance-todos/:id/choose         { option, note?, letters? } (HR)
 *   POST /payroll/compliance-todos/:id/approve        { note? } (the Owner; not the one who chose) → applied, dated
 *   POST /payroll/compliance-todos/:id/dismiss        { reason } (a WARN / INFO)
 *   GET  /payroll/bonus                               the bonus runs
 *   POST /payroll/bonus/prepare                       { year: '2026-27', ratePct?, allocableSurplus?, note? } (HR; again while DRAFT)
 *   GET  /payroll/bonus/:id                           the run, its lines, warnings (late, unverified)
 *   POST /payroll/bonus/:id/approve                   (the Owner; not the preparer)
 *   POST /payroll/bonus/:id/schedule                  { runId } — BONUS one-time items in that open run
 *   POST /payroll/bonus/:id/unschedule
 *   DELETE /payroll/bonus/:id                         a draft
 *   GET  /payroll/bonus/:id/register?format=xlsx|pdf  { fileName, mimeType, contentBase64 }
 * The structure editor's live check comes with POST /payroll/structures/preview (`compliance`); salary
 * save, leave / attendance policy save and the run lock run their checks in their own routes.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import * as W from '../services/complianceChecks/wire.js';
import * as T from '../services/complianceChecks/todos.js';
import * as B from '../services/complianceChecks/bonus.js';

const router = Router();
const whole = companyWide('Payroll compliance belongs to the whole company. Your access covers your org unit and everything under it.');
const view = [...guard(PERM.payroll.view), whole];
const viewPay = [...guard(PERM.payroll.view, { also: [PERM.payView] }), whole];
const editPay = [...guard(PERM.payroll.edit, { also: [PERM.payView] }), whole];
const approvePay = [...guard(PERM.payroll.edit, { also: [PERM.payView], note: 'the Owner only, never the one who chose / prepared' }), whole];
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const id = (req) => intParam(req.params.id);

router.get('/payroll/runs/:id/compliance', ...viewPay, handle((req) => W.runCompliance(pool, ctx(req), id(req))));
router.post('/payroll/runs/:id/compliance/acknowledge', ...editPay, handle((req) => tx(req, (db, c) => W.acknowledgeRun(db, c, id(req), req.body ?? {}))));

router.get('/payroll/compliance-todos/summary', ...view, handle(async (req) => {
  const r = await T.listTodos(pool, ctx(req).companyId);
  return { counts: r.counts, latest: r.todos.slice(0, 4).map((t) => ({ id: t.id, title: t.title, severity: t.severity, status: t.status, deadline: t.deadline, overdue: t.overdue, peopleCount: t.peopleCount })) };
}));
router.get('/payroll/compliance-todos', ...viewPay, handle((req) => T.listTodos(pool, ctx(req).companyId, { status: ['open', 'done', 'all'].includes(req.query.status) ? req.query.status : 'open' })));
router.post('/payroll/compliance-todos/check-now', ...editPay, handle(async (req) => {
  const c = ctx(req);
  const sync = await withTransaction((db) => T.syncTodos(db, c.companyId, { trigger: 'CHECK_NOW', userId: c.userId }));
  return { sync, ...(await T.listTodos(pool, c.companyId)) };
}));
router.get('/payroll/compliance-todos/:id', ...viewPay, handle((req) => T.readTodo(pool, ctx(req), id(req))));
router.post('/payroll/compliance-todos/:id/choose', ...editPay, handle((req) => tx(req, (db, c) => T.chooseOption(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/payroll/compliance-todos/:id/approve', ...approvePay, handle((req) => tx(req, (db, c) => T.approveTodo(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/payroll/compliance-todos/:id/dismiss', ...editPay, handle((req) => tx(req, (db, c) => T.dismissTodo(db, c, id(req), req.body ?? {}, reqId(req)))));

router.get('/payroll/bonus', ...viewPay, handle((req) => B.listBonusRuns(pool, ctx(req).companyId)));
router.post('/payroll/bonus/prepare', ...editPay, handle((req) => tx(req, (db, c) => B.prepareBonus(db, c, req.body ?? {}, reqId(req)))));
router.get('/payroll/bonus/:id', ...viewPay, handle((req) => B.readBonusRun(pool, ctx(req), id(req))));
router.post('/payroll/bonus/:id/approve', ...approvePay, handle((req) => tx(req, (db, c) => B.approveBonus(db, c, id(req), reqId(req)))));
router.post('/payroll/bonus/:id/schedule', ...editPay, handle((req) => tx(req, (db, c) => B.scheduleBonus(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/payroll/bonus/:id/unschedule', ...editPay, handle((req) => tx(req, (db, c) => B.unscheduleBonus(db, c, id(req), reqId(req)))));
router.delete('/payroll/bonus/:id', ...editPay, handle((req) => tx(req, (db, c) => B.removeBonus(db, c, id(req), reqId(req)))));
router.get('/payroll/bonus/:id/register', ...viewPay, handle(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  return B.bonusRegister(pool, ctx(req), id(req), req.query.format === 'pdf' ? 'pdf' : 'xlsx');
}));

export default router;
