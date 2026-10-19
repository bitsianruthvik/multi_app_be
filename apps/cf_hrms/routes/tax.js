/**
 * tax.js — income tax in payroll (TM/CF_HRMS_HIRING_SPEC.md §25.4; services/payrollTax/).
 *
 * Rights: the `payroll` area. Anything that shows a person's amounts (declarations, proofs, the tax
 * sheet, the quarterly return's rows, Forms 16 / 130) ALSO needs the named right cf_hrms_pay_view,
 * and each read of another person's tax is audited (hrms_pay_salary_read). The "Reviewed by our CA"
 * tick is the Owner's (the service refuses anybody else). Payroll belongs to the whole company.
 *
 * HR
 *   GET    /tax/years                                 { years, current }
 *   GET    /tax/years/:year                           { settings, defaults, deductor, forms, review, canTickReview }
 *   PUT    /tax/years/:year                           { declarationFrom, declarationTo, proofFrom, proofTo, regimeCutoff }
 *   POST   /tax/years/:year/ca-review                 { reviewed, note? } — the Owner only
 *   PUT    /tax/deductor                              { tan, pan, name, branch, address, responsible }
 *   GET    /tax/:year/profiles                        ?q=&regime=&pan=missing — regime counts, missing PAN
 *   PUT    /tax/:year/profiles/:employeeId            { city?, metro?, declarationOpenUntil?, note? }
 *   PUT    /tax/:year/profiles/:employeeId/regime     { regime, reason? } — after the cut-off: once, with a reason
 *   GET    /tax/:year/declarations/:employeeId        a person's lines                         (+ pay view; audited)
 *   POST   /tax/:year/declarations/:employeeId        { kind, amount?, details }               (+ pay view)
 *   PUT    /tax/declaration-lines/:id                 { amount?, details? }                    (+ pay view)
 *   DELETE /tax/declaration-lines/:id                                                          (remove + pay view)
 *   GET    /tax/:year/proofs                          ?status=SUBMITTED|VERIFIED|REJECTED|DECLARED|ALL&kind=&q=  (+ pay view)
 *   GET    /tax/proof-files/:id                       { fileName, mimeType, contentBase64 }    (+ pay view; audited)
 *   POST   /tax/declaration-lines/:id/proofs          { fileName, contentBase64 } — HR uploads for the person (upload + pay view)
 *   POST   /tax/declaration-lines/:id/verify          { acceptedAmount?, withoutProof? }       (+ pay view)
 *   POST   /tax/declaration-lines/:id/reject          { reason }                               (+ pay view)
 *   POST   /tax/:year/proofs/bulk-accept              { lineIds }                              (+ pay view)
 *   GET    /tax/:year/sheet/:employeeId               ?month=YYYY-MM                           (+ pay view; audited)
 *   GET    /tax/:year/challans                        months, deposits, warnings
 *   POST   /tax/:year/challans                        { month, challanSerial, bsrCode, depositDate, tax, surcharge?, cess?, interest?, fee?, others?, minorHead?, note? }
 *   PUT    /tax/challans/:id                          the same, any of them
 *   DELETE /tax/challans/:id                          (remove)
 *   GET    /tax/:year/quarters/:quarter               challans, Annexure I (II in Q4), validation  (+ pay view; audited)
 *   GET    /tax/:year/quarters/:quarter/workbook      the Excel for the RPU                         (+ pay view; audited)
 *   GET    /tax/:year/forms                           Part B / Part A per person, unmatched Part A files (+ pay view)
 *   POST   /tax/:year/forms/generate                  { employeeIds? } — Part B (+ Form 12BA / 123)  (+ pay view)
 *   POST   /tax/:year/forms/part-a                    { fileName, contentBase64 } a PDF or a ZIP (upload + pay view)
 *   PUT    /tax/:year/forms/part-a/:fileId            { employeeId } (upload + pay view)
 *   GET    /tax/:year/forms/:employeeId/file          ?part=A|B|merged                              (+ pay view; audited)
 *   POST   /tax/:year/forms/release                   { release } — shows them in My tax › Forms
 *
 * THE PERSON (self view; the employee comes from the login, never from the request)
 *   GET    /user/me/tax                               { years, current, employee }
 *   GET    /user/me/tax/:year                         the year: settings, profile, regime compare, review
 *   PUT    /user/me/tax/:year/regime                  { regime } — until the cut-off
 *   GET    /user/me/tax/:year/declarations            lines, kinds, windows
 *   POST   /user/me/tax/:year/declarations            { kind, amount?, details }  — in the declaration window
 *   PUT    /user/me/tax/declarations/:id              { amount?, details? }
 *   DELETE /user/me/tax/declarations/:id
 *   POST   /user/me/tax/declarations/:id/proofs       { fileName, contentBase64 } — in the proof window
 *   GET    /user/me/tax/proofs/:fileId                { fileName, mimeType, contentBase64 }
 *   DELETE /user/me/tax/proofs/:fileId
 *   GET    /user/me/tax/:year/sheet                   ?month=
 *   GET    /user/me/tax/forms                         my released Forms 16 / 130
 *   GET    /user/me/tax/:year/forms/file              ?part=merged|A|B
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import { auditSalaryRead } from '../services/payroll/payrollService.js';
import { readYear as yearParam, myEmployeeId, yearOf, today, loadRules, formsOf } from '../services/payrollTax/common.js';
import * as SET from '../services/payrollTax/settings.js';
import * as PRO from '../services/payrollTax/profiles.js';
import * as DEC from '../services/payrollTax/declarations.js';
import * as PRF from '../services/payrollTax/proofs.js';
import { taxSheet } from '../services/payrollTax/sheet.js';
import * as CH from '../services/payrollTax/challans.js';
import { quarterData, quarterWorkbook } from '../services/payrollTax/quarterly.js';
import * as F16 from '../services/payrollTax/form16.js';
import { transport } from '../services/payrollTax/files.js';

const router = Router();
const whole = companyWide('Payroll belongs to the whole company. Your access covers your own department only.');
const view = [...guard(PERM.payroll.view), whole];
const viewPay = [...guard(PERM.payroll.view, { also: [PERM.payView] }), whole];
const edit = [...guard(PERM.payroll.edit), whole];
const editPay = [...guard(PERM.payroll.edit, { also: [PERM.payView] }), whole];
const remove = [...guard(PERM.payroll.remove), whole];
const removePay = [...guard(PERM.payroll.remove, { also: [PERM.payView] }), whole];
const uploadPay = [...guard(PERM.payroll.upload, { also: [PERM.payView] }), whole];
const self = guard(PERM.selfView);

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const emp = (req) => intParam(req.params.employeeId, 'employeeId');
const Y = (req) => yearParam(req.params.year);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;
const rulesOf = async (year) => (await loadRules(pool, year)).rules;
const noStore = (res) => res.set('Cache-Control', 'no-store');

/* ── HR: the year, the deductor ─────────────────────────────────────── */
router.get('/tax/years', ...view, handle(async () => ({ years: await SET.taxYears(pool), current: yearOf(today().slice(0, 7)) })));
router.get('/tax/years/:year', ...view, handle((req) => SET.readYear(pool, ctx(req), Y(req))));
router.put('/tax/years/:year', ...edit, handle((req) => tx(req, (db, c) => SET.putYearSettings(db, c, Y(req), req.body ?? {}, reqId(req)))));
router.post('/tax/years/:year/ca-review', ...guard(PERM.payroll.edit, { note: 'the Owner only (refused for anybody else)' }), whole,
  handle((req) => tx(req, (db, c) => SET.setCaReviewed(db, c, Y(req), req.body ?? {}, reqId(req)))));
router.put('/tax/deductor', ...edit, handle((req) => tx(req, (db, c) => SET.putDeductor(db, c, req.body ?? {}, reqId(req)))));

/* ── HR: profiles ───────────────────────────────────────────────────── */
router.get('/tax/:year/profiles', ...view, handle((req) => PRO.listProfiles(pool, ctx(req), Y(req), req.query ?? {})));
router.put('/tax/:year/profiles/:employeeId', ...edit, handle((req) => tx(req, (db, c) => PRO.putProfile(db, c, emp(req), Y(req), req.body ?? {}, reqId(req)))));
router.put('/tax/:year/profiles/:employeeId/regime', ...edit, handle((req) => tx(req, (db, c) => PRO.chooseRegime(db, c, emp(req), Y(req), req.body ?? {}, { by: 'HR', requestId: reqId(req) }))));

/* ── HR: declarations and proofs ────────────────────────────────────── */
router.get('/tax/:year/declarations/:employeeId', ...viewPay, handle((req) => tx(req, async (db, c) => {
  const year = Y(req);
  await auditSalaryRead(db, c, [emp(req)], `tax declarations ${year}`, reqId(req));
  return DEC.listLines(db, c, emp(req), year, { rules: await rulesOf(year) });
})));
router.post('/tax/:year/declarations/:employeeId', ...editPay, handle(async (req) => {
  const year = Y(req);
  const rules = await rulesOf(year);
  return tx(req, (db, c) => DEC.addLine(db, c, emp(req), year, req.body ?? {}, { rules, by: 'HR', requestId: reqId(req) }));
}));
router.put('/tax/declaration-lines/:id', ...editPay, handle(async (req) => tx(req, async (db, c) => {
  const [[r]] = await db.query('SELECT tax_year FROM hrms_tax_declaration_lines WHERE company_id = ? AND id = ?', [c.companyId, id(req)]);
  return DEC.updateLine(db, c, id(req), req.body ?? {}, { rules: r ? await rulesOf(r.tax_year) : null, by: 'HR', requestId: reqId(req) });
})));
router.delete('/tax/declaration-lines/:id', ...removePay, handle((req) => tx(req, (db, c) => DEC.removeLine(db, c, id(req), { by: 'HR', requestId: reqId(req) }))));
router.get('/tax/:year/proofs', ...viewPay, handle((req) => PRF.proofQueue(pool, ctx(req), Y(req), req.query ?? {})));
router.get('/tax/proof-files/:id', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    const f = await PRF.proofFile(db, c, id(req));
    await auditSalaryRead(db, c, [f.row.employee_id], `tax proof ${f.row.file_name}`, reqId(req));
    return transport(f);
  });
}));
router.post('/tax/declaration-lines/:id/proofs', ...uploadPay, handle((req) => tx(req, (db, c) => PRF.uploadProof(db, c, id(req), req.body ?? {}, { by: 'HR', requestId: reqId(req) }))));
router.post('/tax/declaration-lines/:id/verify', ...editPay, handle((req) => tx(req, (db, c) => PRF.verifyLine(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/tax/declaration-lines/:id/reject', ...editPay, handle((req) => tx(req, (db, c) => PRF.rejectLine(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/tax/:year/proofs/bulk-accept', ...editPay, handle((req) => tx(req, (db, c) => PRF.bulkAccept(db, c, Y(req), req.body ?? {}, reqId(req)))));

/* ── HR: the tax sheet ──────────────────────────────────────────────── */
router.get('/tax/:year/sheet/:employeeId', ...viewPay, handle((req) => tx(req, async (db, c) => {
  const year = Y(req);
  await auditSalaryRead(db, c, [emp(req)], `tax sheet ${year}`, reqId(req));
  return taxSheet(db, c, emp(req), year, { month: req.query.month ? String(req.query.month) : null });
})));

/* ── HR: challans ───────────────────────────────────────────────────── */
router.get('/tax/:year/challans', ...view, handle((req) => CH.listChallans(pool, ctx(req), Y(req))));
router.post('/tax/:year/challans', ...edit, handle((req) => tx(req, (db, c) => CH.addChallan(db, c, Y(req), req.body ?? {}, reqId(req)))));
router.put('/tax/challans/:id', ...edit, handle((req) => tx(req, (db, c) => CH.updateChallan(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/tax/challans/:id', ...remove, handle((req) => tx(req, (db, c) => CH.removeChallan(db, c, id(req), reqId(req)))));

/* ── HR: the quarterly return ───────────────────────────────────────── */
router.get('/tax/:year/quarters/:quarter', ...viewPay, handle((req) => tx(req, async (db, c) => {
  const d = await quarterData(db, c, Y(req), req.params.quarter);
  await auditSalaryRead(db, c, [...new Set([...d.deductees.map((r) => r.employee.id), ...(d.annexureII ?? []).map((a) => a.employee.id)])], `quarterly return ${d.year} ${d.quarter}`, reqId(req));
  return d;
})));
router.get('/tax/:year/quarters/:quarter/workbook', ...viewPay, handle((req) => tx(req, async (db, c) => {
  const { employeeIds, ...out } = await quarterWorkbook(db, c, Y(req), req.params.quarter);
  await auditSalaryRead(db, c, employeeIds, `quarterly return workbook ${Y(req)} ${req.params.quarter}`, reqId(req));
  return out;
})));

/* ── HR: Forms 16 / 130 ─────────────────────────────────────────────── */
router.get('/tax/:year/forms', ...viewPay, handle((req) => F16.listForms(pool, ctx(req), Y(req))));
router.post('/tax/:year/forms/generate', ...editPay, handle((req) => tx(req, (db, c) => F16.generateForms(db, c, Y(req), req.body ?? {}, reqId(req)))));
router.post('/tax/:year/forms/part-a', ...uploadPay, handle((req) => tx(req, (db, c) => F16.uploadPartA(db, c, Y(req), req.body ?? {}, reqId(req)))));
router.put('/tax/:year/forms/part-a/:fileId', ...uploadPay, handle((req) => tx(req, (db, c) => F16.assignPartA(db, c, Y(req), intParam(req.params.fileId, 'fileId'), req.body ?? {}, reqId(req)))));
router.get('/tax/:year/forms/:employeeId/file', ...viewPay, handle(async (req, res) => {
  noStore(res);
  return tx(req, async (db, c) => {
    await auditSalaryRead(db, c, [emp(req)], `Form 16 / 130 ${Y(req)}`, reqId(req));
    return F16.formFile(db, c, Y(req), emp(req), String(req.query.part ?? 'merged'));
  });
}));
router.post('/tax/:year/forms/release', ...edit, handle((req) => tx(req, (db, c) => SET.releaseForms(db, c, Y(req), req.body ?? {}, reqId(req)))));

/* ── The person ─────────────────────────────────────────────────────── */
router.get('/user/me/tax', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  const [[e]] = await pool.query('SELECT employee_code, full_name FROM hrms_employees WHERE id = ?', [me]);
  return { years: await SET.taxYears(pool), current: yearOf(today().slice(0, 7)), employee: { code: e.employee_code, name: e.full_name } };
}));
router.get('/user/me/tax/forms', self, handle(async (req, res) => { noStore(res); const c = ctx(req); return F16.myForms(pool, c, await myEmployeeId(pool, c)); }));
router.get('/user/me/tax/:year', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  const year = Y(req);
  const settings = await SET.yearSettings(pool, c.companyId, year);
  const profile = await PRO.profileOf(pool, c.companyId, me, year);
  const sheet = await taxSheet(pool, c, me, year, { month: req.query.month ? String(req.query.month) : null });
  return {
    year, settings, profile, review: SET.review(settings), forms: formsOf(await rulesOf(year)),
    regime: { chosen: profile.regime, how: profile.regimeSetHow, canChange: settings.regimeOpen, cutoff: settings.regimeCutoff },
    compare: sheet.available ? { sentence: sheet.sentence, cheaper: sheet.cheaper, saving: sheet.saving, OLD: sheet.regimes.OLD.projectedTax, NEW: sheet.regimes.NEW.projectedTax, month: sheet.monthLabel, refused: { OLD: sheet.regimes.OLD.computation.refused, NEW: sheet.regimes.NEW.computation.refused } } : null,
  };
}));
router.put('/user/me/tax/:year/regime', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  return tx(req, (db, c2) => PRO.chooseRegime(db, c2, me, Y(req), { regime: req.body?.regime }, { by: 'SELF', requestId: reqId(req) }));
}));
router.get('/user/me/tax/:year/declarations', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  const year = Y(req);
  return DEC.listLines(pool, c, await myEmployeeId(pool, c), year, { rules: await rulesOf(year) });
}));
router.post('/user/me/tax/:year/declarations', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  const year = Y(req);
  const rules = await rulesOf(year);
  return tx(req, (db, c2) => DEC.addLine(db, c2, me, year, req.body ?? {}, { rules, by: 'SELF', requestId: reqId(req) }));
}));
router.put('/user/me/tax/declarations/:id', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  return tx(req, async (db, c2) => {
    const [[r]] = await db.query('SELECT tax_year FROM hrms_tax_declaration_lines WHERE company_id = ? AND id = ? AND employee_id = ?', [c2.companyId, id(req), me]);
    return DEC.updateLine(db, c2, id(req), req.body ?? {}, { rules: r ? await rulesOf(r.tax_year) : null, by: 'SELF', employeeId: me, requestId: reqId(req) });
  });
}));
router.delete('/user/me/tax/declarations/:id', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  return tx(req, (db, c2) => DEC.removeLine(db, c2, id(req), { by: 'SELF', employeeId: me, requestId: reqId(req) }));
}));
router.post('/user/me/tax/declarations/:id/proofs', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  return tx(req, (db, c2) => PRF.uploadProof(db, c2, id(req), req.body ?? {}, { by: 'SELF', employeeId: me, requestId: reqId(req) }));
}));
router.get('/user/me/tax/proofs/:fileId', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  return transport(await PRF.proofFile(pool, c, intParam(req.params.fileId, 'fileId'), { employeeId: await myEmployeeId(pool, c) }));
}));
router.delete('/user/me/tax/proofs/:fileId', self, handle(async (req) => {
  const c = ctx(req);
  const me = await myEmployeeId(pool, c);
  return tx(req, (db, c2) => PRF.removeProof(db, c2, intParam(req.params.fileId, 'fileId'), { employeeId: me, by: 'SELF', requestId: reqId(req) }));
}));
router.get('/user/me/tax/:year/sheet', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  return taxSheet(pool, c, await myEmployeeId(pool, c), Y(req), { month: req.query.month ? String(req.query.month) : null });
}));
router.get('/user/me/tax/:year/forms/file', self, handle(async (req, res) => {
  noStore(res);
  const c = ctx(req);
  return F16.myFormFile(pool, c, await myEmployeeId(pool, c), Y(req), String(req.query.part ?? 'merged'));
}));

export default router;
