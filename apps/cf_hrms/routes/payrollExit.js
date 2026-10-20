/**
 * payrollExit.js — payroll P3b (TM/CF_HRMS_HIRING_SPEC.md §25.5, §28.6): the payroll policy, attendance in the
 * run, full and final settlements, claim types and claims, retirement contributions above the limit.
 * services/payrollExit/.
 *
 * Rights: the `payroll` area; whatever shows a person's AMOUNTS also needs the named right cf_hrms_pay_view,
 * and each read of other people's amounts is audited (hrms_pay_salary_read). Payroll belongs to the whole
 * company. HR never approves their own claim or settlement (403 OWN_RECORD).
 *
 * HR
 *   GET    /payroll/policy                                  { policy }  (payroll view)
 *   PUT    /payroll/policy                                  { overtimeRateFormula?, encashRateFormula?, noticeRateFormula?, flexiYearEnd?, claimsManagerFirst? } (edit)
 *   GET    /payroll/runs/:id/attendance                     the month's attendance state for the run (view)
 *   POST   /payroll/runs/:id/attendance-override            { reason } — pay this month without attendance (edit + pay view)
 *   DELETE /payroll/runs/:id/attendance-override                                                    (edit + pay view)
 *   GET    /payroll/settlements                             people leaving / left with their settlement   (+ pay view; audited)
 *   GET    /payroll/settlements/employees/:employeeId       { settlement, fresh }                         (+ pay view; audited)
 *   POST   /payroll/settlements/employees/:employeeId/preview  { inputs } → the statement, nothing saved (+ pay view)
 *   PUT    /payroll/settlements/employees/:employeeId       { inputs } — save the DRAFT                   (edit + pay view)
 *   POST   /payroll/settlements/:id/approve                 409 NOT_CLOSED / PROBLEMS; 403 OWN_RECORD     (edit + pay view)
 *   POST   /payroll/settlements/:id/unapprove               { note? }                                     (edit + pay view)
 *   DELETE /payroll/settlements/:id                         a DRAFT                                       (remove + pay view)
 *   GET    /payroll/settlements/:id/file                    the statement PDF                             (+ pay view; audited)
 *   GET    /payroll/claim-types                             { types, treatments }  (view)
 *   POST   /payroll/claim-types                             { code, name, yearlyLimit?, taxTreatment, taxRule?, billsNeeded?, flexible? } (edit)
 *   POST   /payroll/claim-types/setup                       the ready-made five that are missing (edit)
 *   PUT    /payroll/claim-types/:id                         (edit)
 *   DELETE /payroll/claim-types/:id                         409 IN_USE (remove)
 *   GET    /payroll/claims                                  ?status=WAITING|…&year=&q=                    (+ pay view; audited)
 *   GET    /payroll/claims/:id                              { claim, context }                            (+ pay view; audited)
 *   POST   /payroll/claims/:id/approve                      { amount?, note? } — pays in the next run     (edit + pay view)
 *   POST   /payroll/claims/:id/reject                       { note }                                      (edit + pay view)
 *   POST   /payroll/claims/:id/reopen                       { note? } — an approved, unpaid claim back to HR (edit + pay view)
 *   GET    /payroll/claims/:id/bills/:fileId                the bill                                      (+ pay view; audited)
 *   GET    /tax/:year/retirement                            employer PF + NPS + superannuation against the limit (+ pay view; audited)
 *   PUT    /tax/:year/retirement/:employeeId                the accretion facts (rule 3B / rule 16)       (edit + pay view)
 *
 * THE PERSON (self view; the employee from the login, never from the request)
 *   GET    /user/me/claims                                  my claim types (this year's use) and my claims
 *   POST   /user/me/claims                                  { claimTypeId, billDate, amount, description?, journeys?, bills: [{ fileName, contentBase64 }] }
 *   POST   /user/me/claims/:id/bills                        { fileName, contentBase64 }
 *   POST   /user/me/claims/:id/withdraw
 *   GET    /user/me/claims/:id/bills/:fileId
 *   GET    /user/me/settlement                              my approved / paid full and final (null otherwise)
 *   GET    /user/me/settlement/file                         its PDF
 * THE MANAGER (Approvals, kind CLAIM — routes/self.js): the bills of a claim waiting for them:
 *   GET    /user/me/approvals/claim/:id/bills/:fileId
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { auditSalaryRead } from '../services/payroll/payrollService.js';
import { runRow, OPEN } from '../services/payroll/runService.js';
import { refuse } from '../services/payroll/common.js';
import { readYear as yearParam, myEmployeeId } from '../services/payrollTax/common.js';
import { letterheadOf } from '../services/payroll/payslip.js';
import { employeeIdOfLogin } from '../services/leave/requestService.js';
import * as POL from '../services/payrollExit/policy.js';
import * as ATT from '../services/payrollExit/attendancePay.js';
import * as FNF from '../services/payrollExit/settlement.js';
import * as CL from '../services/payrollExit/claims.js';
import * as RF from '../services/payrollExit/retirementFacts.js';
import { settlementPdf, settlementFileName } from '../services/payrollExit/settlementPdf.js';

const router = Router();
const whole = companyWide('Payroll belongs to the whole company. Your access covers your own department only.');
const view = [...guard(PERM.payroll.view), whole];
const viewPay = [...guard(PERM.payroll.view, { also: [PERM.payView] }), whole];
const edit = [...guard(PERM.payroll.edit), whole];
const editPay = [...guard(PERM.payroll.edit, { also: [PERM.payView] }), whole];
const remove = [...guard(PERM.payroll.remove), whole];
const removePay = [...guard(PERM.payroll.remove, { also: [PERM.payView] }), whole];
const self = guard(PERM.selfView);

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const emp = (req) => intParam(req.params.employeeId, 'employeeId');
const fileId = (req) => intParam(req.params.fileId, 'fileId');
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const noStore = (res) => res.set('Cache-Control', 'no-store');

/* ── the policy ─────────────────────────────────────────────────────── */
router.get('/payroll/policy', ...view, handle(async (req) => ({ policy: await POL.policyOf(pool, ctx(req).companyId) })));
router.put('/payroll/policy', ...edit, handle((req) => tx(req, (db, c) => POL.putPolicy(db, c, req.body ?? {}, reqId(req)))));

/* ── attendance in the run ──────────────────────────────────────────── */
router.get('/payroll/runs/:id/attendance', ...view, handle(async (req) => {
  const c = ctx(req);
  const r = await runRow(pool, c.companyId, id(req));
  return { attendance: await ATT.attendanceState(pool, c.companyId, r.period_month, r.id) };
}));
router.post('/payroll/runs/:id/attendance-override', ...editPay, handle((req) => tx(req, async (db, c) => {
  const r = await runRow(db, c.companyId, id(req), { forUpdate: true });
  if (!OPEN.includes(r.status)) throw refuse('WRONG_STATUS', 'Only a draft or calculated payroll can be paid without attendance.');
  return ATT.setOverride(db, c, r, req.body ?? {}, reqId(req));
})));
router.delete('/payroll/runs/:id/attendance-override', ...editPay, handle((req) => tx(req, async (db, c) => {
  const r = await runRow(db, c.companyId, id(req), { forUpdate: true });
  if (!OPEN.includes(r.status)) throw refuse('WRONG_STATUS', 'The payroll is locked.');
  return ATT.clearOverride(db, c, r, reqId(req));
})));

/* ── full and final ─────────────────────────────────────────────────── */
router.get('/payroll/settlements', ...viewPay, handle(async (req, res) => { noStore(res); return tx(req, (db, c) => FNF.listSettlements(db, c, req.query ?? {}, reqId(req))); }));
router.get('/payroll/settlements/employees/:employeeId', ...viewPay, handle(async (req, res) => { noStore(res); return tx(req, (db, c) => FNF.readSettlement(db, c, emp(req), reqId(req))); }));
router.post('/payroll/settlements/employees/:employeeId/preview', ...viewPay, handle((req) => tx(req, (db, c) => FNF.previewSettlement(db, c, emp(req), req.body ?? {}))));
router.put('/payroll/settlements/employees/:employeeId', ...editPay, handle((req) => tx(req, (db, c) => FNF.saveDraft(db, c, emp(req), req.body ?? {}, reqId(req)))));
router.post('/payroll/settlements/:id/approve', ...editPay, handle((req) => tx(req, (db, c) => FNF.approveSettlement(db, c, id(req), reqId(req)))));
router.post('/payroll/settlements/:id/unapprove', ...editPay, handle((req) => tx(req, (db, c) => FNF.unapproveSettlement(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/settlements/:id', ...removePay, handle((req) => tx(req, (db, c) => FNF.deleteSettlement(db, c, id(req), reqId(req)))));
router.get('/payroll/settlements/:id/file', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    const d = await FNF.pdfData(db, c, { id: id(req) });
    await auditSalaryRead(db, c, [d.employeeId], 'full and final statement PDF', reqId(req));
    const buffer = await settlementPdf(d, await letterheadOf(db, c.companyId));
    return { fileName: settlementFileName(d.statement), mimeType: 'application/pdf', contentBase64: buffer.toString('base64') };
  });
}));

/* ── claim types ────────────────────────────────────────────────────── */
router.get('/payroll/claim-types', ...view, handle((req) => CL.listTypes(pool, ctx(req))));
router.post('/payroll/claim-types/setup', ...edit, handle((req) => tx(req, (db, c) => CL.setupTypes(db, c, reqId(req)))));
router.post('/payroll/claim-types', ...edit, handle((req) => tx(req, (db, c) => CL.createType(db, c, req.body ?? {}, reqId(req)))));
router.put('/payroll/claim-types/:id', ...edit, handle((req) => tx(req, (db, c) => CL.updateType(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/claim-types/:id', ...remove, handle((req) => tx(req, (db, c) => CL.deleteType(db, c, id(req), reqId(req)))));

/* ── claims (HR) ────────────────────────────────────────────────────── */
router.get('/payroll/claims', ...viewPay, handle(async (req, res) => { noStore(res); return tx(req, (db, c) => CL.listClaims(db, c, req.query ?? {}, reqId(req))); }));
router.get('/payroll/claims/:id', ...viewPay, handle(async (req, res) => { noStore(res); return tx(req, (db, c) => CL.readClaim(db, c, id(req), reqId(req))); }));
router.post('/payroll/claims/:id/approve', ...editPay, handle((req) => tx(req, (db, c) => CL.approveClaim(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/payroll/claims/:id/reject', ...editPay, handle((req) => tx(req, (db, c) => CL.rejectClaim(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/payroll/claims/:id/reopen', ...editPay, handle((req) => tx(req, (db, c) => CL.reopenClaim(db, c, id(req), req.body ?? {}, reqId(req)))));
router.get('/payroll/claims/:id/bills/:fileId', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    const { claim } = await CL.readClaim(db, c, id(req), reqId(req));
    void claim;
    return CL.billFile(db, c, id(req), fileId(req));
  });
}));

/* ── retirement contributions above the limit ──────────────────────── */
router.get('/tax/:year/retirement', ...viewPay, handle(async (req, res) => { noStore(res); return tx(req, (db, c) => RF.listRetirement(db, c, yearParam(req.params.year), reqId(req))); }));
router.put('/tax/:year/retirement/:employeeId', ...editPay, handle((req) => tx(req, (db, c) => RF.putFacts(db, c, yearParam(req.params.year), emp(req), req.body ?? {}, reqId(req)))));

/* ── the person ─────────────────────────────────────────────────────── */
const me = async (req) => myEmployeeId(pool, ctx(req));
router.get('/user/me/claims', self, handle(async (req, res) => { noStore(res); return CL.myClaims(pool, ctx(req), await me(req), { year: req.query?.year && /^\d{4}-\d{2}$/.test(String(req.query.year)) ? String(req.query.year) : null }); }));
router.post('/user/me/claims', self, handle(async (req) => { const e = await me(req); return tx(req, (db, c) => CL.submitClaim(db, c, e, req.body ?? {}, reqId(req))); }));
router.post('/user/me/claims/:id/bills', self, handle(async (req) => { const e = await me(req); return tx(req, (db, c) => CL.addMyBill(db, c, e, id(req), req.body ?? {}, reqId(req))); }));
router.post('/user/me/claims/:id/withdraw', self, handle(async (req) => { const e = await me(req); return tx(req, (db, c) => CL.withdrawMine(db, c, e, id(req), reqId(req))); }));
router.get('/user/me/claims/:id/bills/:fileId', self, handle(async (req, res) => { noStore(res); return CL.myBillFile(pool, ctx(req), await me(req), id(req), fileId(req)); }));
router.get('/user/me/settlement', self, handle(async (req, res) => { noStore(res); return FNF.mySettlement(pool, ctx(req), await me(req)); }));
router.get('/user/me/settlement/file', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  const d = await FNF.pdfData(pool, c, { employeeId: await me(req), mine: true });
  const buffer = await settlementPdf(d, await letterheadOf(pool, c.companyId));
  return { fileName: settlementFileName(d.statement), mimeType: 'application/pdf', contentBase64: buffer.toString('base64') };
}));
router.get('/user/me/approvals/claim/:id/bills/:fileId', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  const viewer = { userId: c.userId, employeeId: await employeeIdOfLogin(pool, c) };
  await CL.managerDetail(pool, c, viewer, id(req));
  return CL.billFile(pool, c, id(req), fileId(req));
}));

export default router;
