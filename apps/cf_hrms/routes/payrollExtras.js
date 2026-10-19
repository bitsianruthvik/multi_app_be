/**
 * payrollExtras.js — payroll extras P3a (TM/CF_HRMS_HIRING_SPEC.md §25.5): the statutory return files,
 * the perquisites register and the Form 10E / Form 39 worksheet. services/payrollExtras/.
 *
 * Rights: the `payroll` area; whatever shows a person's AMOUNTS also needs the named right
 * cf_hrms_pay_view, and each read of other people's amounts is audited (hrms_pay_salary_read).
 * The returns screen opens on payroll view: without pay view it shows the counts and the checks with
 * the amounts left out. Payroll belongs to the whole company.
 *
 * HR
 *   GET    /payroll/returns/:month                      the month's PF / ESI / PT figures and the checks (amounts: + pay view; audited)
 *   GET    /payroll/returns/:month/files/:kind          ECR | ESI | PT → { fileName, mimeType, contentBase64 }   (+ pay view; audited)
 *   GET    /tax/:year/perquisites                       the register, valued                                     (+ pay view; audited)
 *   POST   /tax/:year/perquisites                       { employeeId, kind, label?, fromDate, toDate?, facts, note? } (edit + pay view)
 *   POST   /tax/:year/perquisites/preview               the same (or { id, … }) → the value, nothing saved          (+ pay view)
 *   PUT    /tax/perquisites/:id                         { label?, fromDate?, toDate?, facts?, note? }             (edit + pay view)
 *   DELETE /tax/perquisites/:id                                                                                  (remove + pay view)
 *   GET    /tax/:year/form10e                           people with arrears of earlier years, their worksheets    (+ pay view)
 *   GET    /tax/:year/form10e/:employeeId               the kept worksheet and a fresh working                    (+ pay view; audited)
 *   POST   /tax/:year/form10e/:employeeId               { earlier?: { '2024-25': { regime, totalIncome, taxWithout, taxWith } }, receipt? } — work out and keep (edit + pay view)
 *   DELETE /tax/:year/form10e/:employeeId                                                                        (remove + pay view)
 *   GET    /tax/:year/form10e/:employeeId/file          the PDF                                                   (+ pay view; audited)
 *
 * THE PERSON (self view; the employee from the login, never from the request)
 *   GET    /user/me/form10e                             my worksheets (My tax › Forms)
 *   PUT    /user/me/form10e/:year                       { earlier } — type the earlier years' figures; worked out again
 *   GET    /user/me/form10e/:year/file                  the PDF
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, canSeePay } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { auditSalaryRead } from '../services/payroll/payrollService.js';
import { readYear as yearParam, myEmployeeId } from '../services/payrollTax/common.js';
import * as RET from '../services/payrollExtras/statutoryReturns.js';
import * as PQ from '../services/payrollExtras/perquisites.js';
import * as F10 from '../services/payrollExtras/form10e.js';

const router = Router();
const whole = companyWide('Payroll belongs to the whole company. Your access covers your own department only.');
const view = [...guard(PERM.payroll.view, { note: 'amounts only with cf_hrms_pay_view' }), whole];
const viewPay = [...guard(PERM.payroll.view, { also: [PERM.payView] }), whole];
const editPay = [...guard(PERM.payroll.edit, { also: [PERM.payView] }), whole];
const removePay = [...guard(PERM.payroll.remove, { also: [PERM.payView] }), whole];
const self = guard(PERM.selfView);

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const emp = (req) => intParam(req.params.employeeId, 'employeeId');
const Y = (req) => yearParam(req.params.year);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const noStore = (res) => res.set('Cache-Control', 'no-store');
const month = (req) => String(req.params.month ?? '');

/* ── statutory returns ──────────────────────────────────────────────── */
router.get('/payroll/returns/:month', ...view, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    const d = await RET.monthReturns(db, c, month(req));
    if (!canSeePay(req)) return RET.withoutAmounts(d);
    if (d.ready) await auditSalaryRead(db, c, d.employeeIds, `statutory returns ${d.month}`, reqId(req));
    const { employeeIds: _ids, ...out } = d;
    return out;
  });
}));
router.get('/payroll/returns/:month/files/:kind', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    const { employeeIds, ...file } = await RET.fileOf(db, c, month(req), req.params.kind);
    await auditSalaryRead(db, c, employeeIds, `statutory return ${String(req.params.kind).toUpperCase()} ${month(req)}`, reqId(req));
    return file;
  });
}));

/* ── perquisites ────────────────────────────────────────────────────── */
router.get('/tax/:year/perquisites', ...viewPay, handle((req) => tx(req, async (db, c) => {
  const d = await PQ.listYear(db, c, Y(req), req.query ?? {});
  await auditSalaryRead(db, c, d.people.map((p) => p.employee?.id).filter(Boolean), `perquisites ${d.year}`, reqId(req));
  return d;
})));
router.post('/tax/:year/perquisites/preview', ...viewPay, handle((req) => tx(req, (db, c) => PQ.preview(db, c, Y(req), req.body ?? {}))));
router.post('/tax/:year/perquisites', ...editPay, handle((req) => tx(req, (db, c) => PQ.addEntry(db, c, Y(req), req.body ?? {}, reqId(req)))));
router.put('/tax/perquisites/:id', ...editPay, handle((req) => tx(req, (db, c) => PQ.updateEntry(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/tax/perquisites/:id', ...removePay, handle((req) => tx(req, (db, c) => PQ.removeEntry(db, c, id(req), reqId(req)))));

/* ── Form 10E / Form 39 ─────────────────────────────────────────────── */
router.get('/tax/:year/form10e', ...viewPay, handle((req) => F10.listYear(pool, ctx(req), Y(req))));
router.get('/tax/:year/form10e/:employeeId', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    await auditSalaryRead(db, c, [emp(req)], `Form 10E ${Y(req)}`, reqId(req));
    return F10.readOne(db, c, emp(req), Y(req));
  });
}));
router.post('/tax/:year/form10e/:employeeId', ...editPay, handle((req) => tx(req, (db, c) => F10.generate(db, c, emp(req), Y(req), req.body ?? {}, { by: 'HR', requestId: reqId(req) }))));
router.delete('/tax/:year/form10e/:employeeId', ...removePay, handle((req) => tx(req, (db, c) => F10.removeOne(db, c, emp(req), Y(req), reqId(req)))));
router.get('/tax/:year/form10e/:employeeId/file', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    await auditSalaryRead(db, c, [emp(req)], `Form 10E PDF ${Y(req)}`, reqId(req));
    return F10.fileOf(db, c, emp(req), Y(req));
  });
}));

/* ── the person ─────────────────────────────────────────────────────── */
router.get('/user/me/form10e', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  return F10.myWorksheets(pool, c, await myEmployeeId(pool, c));
}));
router.put('/user/me/form10e/:year', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  return tx(req, (db, c2) => F10.generate(db, c2, me, Y(req), { earlier: req.body?.earlier ?? {} }, { by: 'SELF', requestId: reqId(req) }));
}));
router.get('/user/me/form10e/:year/file', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  return F10.fileOf(pool, c, await myEmployeeId(pool, c), Y(req));
}));

export default router;
