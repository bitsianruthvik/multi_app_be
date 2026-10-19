/**
 * payroll.js — running payroll (TM/CF_HRMS_HIRING_SPEC.md §25.2; services/payroll/).
 *
 * Rights: the `payroll` area — view / edit / remove / upload. Anything that shows a person's
 * pay (salaries, runs and their lines, payslips, the bank file) ALSO needs the named right
 * cf_hrms_pay_view, and every such read of another person's salary writes a READ audit row.
 * Components, structures and statutory settings hold no person's pay: payroll view is enough.
 * Payroll belongs to the whole company: a login scoped to a department is refused.
 *
 *   POST   /payroll/setup                       the ready-made components, "Staff standard", the statutory rows (edit)
 *
 *   GET    /payroll/components                  { components, kinds, statutoryKeys, exemptionRules }
 *   POST   /payroll/components                  { code, name, kind, taxable?, exemptionRule?, inPfWage?, inEsiWage?, inGratuityWage?, frequency?, prorateOnLop?, sortOrder?, description? }
 *   PUT    /payroll/components/:id              the same, any of them; status ACTIVE|INACTIVE
 *   DELETE /payroll/components/:id              409 IN_USE while a structure or a run uses it
 *
 *   GET    /payroll/structures                  { structures: [{ …, lines, peopleCount }] }
 *   GET    /payroll/structures/:id              { structure, variables }
 *   POST   /payroll/structures                  { code, name, description?, lines: [{ componentId, formula }] | copyOf }
 *   PUT    /payroll/structures/:id              { name?, description?, status?, lines? }   lines REPLACE the set
 *   DELETE /payroll/structures/:id              409 IN_USE while a salary uses it
 *   POST   /payroll/structures/preview          { lines, annualCtc, overrides?, pfMode? } -> breakdown; writes nothing
 *
 *   GET    /payroll/statutory                   { settings, company, inForce, states, unverified }
 *   POST   /payroll/statutory                   { kind, stateCode, effectiveFrom, settings, source, sourceUrl?, verification?, note? }
 *   PUT    /payroll/statutory/:id               refused for values a locked run used: add a new dated row
 *   DELETE /payroll/statutory/:id
 *   PUT    /payroll/settings                    { stateCode?, debitAccountNo?, debitIfsc?, narration? }
 *
 *   GET    /payroll/salaries                    ?q=&structureId=&has=with|without   (+ pay view; audited)
 *   GET    /payroll/salaries/:employeeId        { employee, current, history }      (+ pay view; audited)
 *   POST   /payroll/salaries                    { employeeId, annualCtc, structureId, effectiveFrom, overrides?, pfMode?, stateCode?, reason? }
 *   PUT    /payroll/salaries/:id                a correction of a row no locked run paid on
 *   DELETE /payroll/salaries/:id                the latest row only, unpaid
 *
 *   GET    /payroll/runs                        { runs, suggestedMonth }            (+ pay view)
 *   POST   /payroll/runs                        { month: 'YYYY-MM', note? } — 409 MONTH_MISSING when the month before has no run
 *   GET    /payroll/runs/:id                    { run, people, items, payslips, payments, stale, can }  (+ pay view; audited)
 *   DELETE /payroll/runs/:id                    a DRAFT or CALCULATED run (remove); once paid or re-opened, the Owner only
 *   GET    /payroll/runs/:id/people/:personId   { run, person, lines, items }        (+ pay view; audited)
 *   POST   /payroll/runs/:id/calculate          409 EARLIER_OPEN while an earlier month is a draft or calculated
 *   POST   /payroll/runs/:id/lock               409 STALE when something changed since the calculation; EARLIER_OPEN; NEGATIVE_NET
 *   POST   /payroll/runs/:id/release            payslips for everyone paid
 *   POST   /payroll/runs/:id/paid               { note? } — records what was paid per person (hrms_pay_payments)
 *   POST   /payroll/runs/:id/reopen             { reason } — the Owner only; 409 LATER_PAID_ARREARS
 *   GET    /payroll/runs/:id/items              { items }                            (audited)
 *   POST   /payroll/runs/:id/items              { employeeId, componentId, amount, note? }
 *   PUT    /payroll/runs/:id/people/:employeeId/tds   { amount, reason } — HR's TDS for the month (wins over the engine)
 *   DELETE /payroll/runs/:id/people/:employeeId/tds   back to the engine (services/payroll/tds.js)
 *   PUT    /payroll/items/:id                   { amount?, note? }
 *   DELETE /payroll/items/:id                   (remove)
 *   GET    /payroll/runs/:id/bank-file          { fileName, mimeType, contentBase64, rows, total, skipped, difference, recover }  LOCKED or later;
 *                                               after a re-open, only the difference from what was paid (audited)
 *   GET    /payroll/runs/:id/payslips           { payslips }                         (audited)
 *   GET    /payroll/payslips/:id/file           { fileName, mimeType, contentBase64 }   (audited)
 *
 * (A person's own: GET /user/me/pay, /user/me/payslips, /user/me/payslips/:id/file — routes/self.js.)
 * (Excel: /excel/pay-salaries/…, /excel/pay-items/…?runId= — routes/excel.js.)
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { companyWide } from '../lib/gates.js';
import * as PAY from '../services/payroll/payrollService.js';
import * as RUN from '../services/payroll/runService.js';
import { payslipPdf, letterheadOf, payslipFileName } from '../services/payroll/payslip.js';

const router = Router();
const whole = companyWide('Payroll belongs to the whole company. Your access covers your own department only.');
const view = [...guard(PERM.payroll.view), whole];
const viewPay = [...guard(PERM.payroll.view, { also: [PERM.payView] }), whole];
const edit = [...guard(PERM.payroll.edit), whole];
const editPay = [...guard(PERM.payroll.edit, { also: [PERM.payView] }), whole];
const removePay = [...guard(PERM.payroll.remove, { also: [PERM.payView] }), whole];
const remove = [...guard(PERM.payroll.remove), whole];

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;

router.post('/payroll/setup', ...edit, handle((req) => tx(req, (db, c) => PAY.setupPayroll(db, c, reqId(req)))));

// Components
router.get('/payroll/components', ...view, handle((req) => PAY.listComponents(pool, ctx(req))));
router.post('/payroll/components', ...edit, handle((req) => tx(req, (db, c) => PAY.createComponent(db, c, req.body ?? {}, reqId(req)))));
router.put('/payroll/components/:id', ...edit, handle((req) => tx(req, (db, c) => PAY.updateComponent(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/components/:id', ...remove, handle((req) => tx(req, (db, c) => PAY.deleteComponent(db, c, id(req), reqId(req)))));

// Structures
router.get('/payroll/structures', ...view, handle((req) => PAY.listStructures(pool, ctx(req))));
router.post('/payroll/structures/preview', ...view, handle((req) => PAY.previewStructure(pool, ctx(req), req.body ?? {})));
router.get('/payroll/structures/:id', ...view, handle((req) => PAY.getStructure(pool, ctx(req), id(req))));
router.post('/payroll/structures', ...edit, handle((req) => tx(req, (db, c) => PAY.createStructure(db, c, req.body ?? {}, reqId(req)))));
router.put('/payroll/structures/:id', ...edit, handle((req) => tx(req, (db, c) => PAY.updateStructure(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/structures/:id', ...remove, handle((req) => tx(req, (db, c) => PAY.deleteStructure(db, c, id(req), reqId(req)))));

// Statutory settings and the company's payroll settings
router.get('/payroll/statutory', ...view, handle((req) => PAY.listStatutory(pool, ctx(req))));
router.post('/payroll/statutory', ...edit, handle((req) => tx(req, (db, c) => PAY.createStatutory(db, c, req.body ?? {}, reqId(req)))));
router.put('/payroll/statutory/:id', ...edit, handle((req) => tx(req, (db, c) => PAY.updateStatutory(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/statutory/:id', ...remove, handle((req) => tx(req, (db, c) => PAY.deleteStatutory(db, c, id(req), reqId(req)))));
router.put('/payroll/settings', ...edit, handle((req) => tx(req, (db, c) => PAY.putSettings(db, c, req.body ?? {}, reqId(req)))));

// Salaries — amounts: pay view, and every read audited (the service writes it)
router.get('/payroll/salaries', ...viewPay, handle((req) => tx(req, (db, c) => PAY.listSalaries(db, c, req.query ?? {}, reqId(req)))));
router.get('/payroll/salaries/:id', ...viewPay, handle((req) => tx(req, (db, c) => PAY.getSalary(db, c, id(req), reqId(req)))));
router.post('/payroll/salaries', ...editPay, handle((req) => tx(req, (db, c) => PAY.createSalary(db, c, req.body ?? {}, reqId(req)))));
router.put('/payroll/salaries/:id', ...editPay, handle((req) => tx(req, (db, c) => PAY.updateSalary(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/salaries/:id', ...removePay, handle((req) => tx(req, (db, c) => PAY.deleteSalary(db, c, id(req), reqId(req)))));

// Runs
router.get('/payroll/runs', ...viewPay, handle((req) => RUN.listRuns(pool, ctx(req))));
router.post('/payroll/runs', ...edit, handle((req) => tx(req, (db, c) => RUN.createRun(db, c, req.body ?? {}, reqId(req)))));
router.get('/payroll/runs/:id', ...viewPay, handle((req) => tx(req, (db, c) => RUN.readRun(db, c, id(req), { requestId: reqId(req) }))));
router.delete('/payroll/runs/:id', ...remove, handle((req) => tx(req, (db, c) => RUN.deleteRun(db, c, id(req), reqId(req)))));
router.get('/payroll/runs/:id/people/:personId', ...viewPay, handle((req) => tx(req, (db, c) => RUN.readRunPerson(db, c, id(req), intParam(req.params.personId, 'personId'), reqId(req)))));
router.post('/payroll/runs/:id/calculate', ...editPay, handle((req) => tx(req, (db, c) => RUN.calculateRun(db, c, id(req), reqId(req)))));
router.post('/payroll/runs/:id/lock', ...editPay, handle((req) => tx(req, (db, c) => RUN.lockRun(db, c, id(req), reqId(req)))));
router.post('/payroll/runs/:id/release', ...editPay, handle((req) => tx(req, (db, c) => RUN.releaseRun(db, c, id(req), reqId(req)))));
router.post('/payroll/runs/:id/paid', ...editPay, handle((req) => tx(req, (db, c) => RUN.markPaid(db, c, id(req), req.body ?? {}, reqId(req)))));
// The Owner only: the guard lets payroll edit in, the service refuses anybody but the Owner (c.owner).
router.post('/payroll/runs/:id/reopen', ...guard(PERM.payroll.edit, { also: [PERM.payView], note: 'the Owner only (refused for anybody else), with a reason' }), whole,
  handle((req) => tx(req, (db, c) => RUN.reopenRun(db, c, id(req), req.body ?? {}, reqId(req)))));
router.get('/payroll/runs/:id/items', ...viewPay, handle((req) => RUN.listItems(pool, ctx(req), id(req), reqId(req))));
router.post('/payroll/runs/:id/items', ...editPay, handle((req) => tx(req, (db, c) => RUN.addItem(db, c, id(req), req.body ?? {}, reqId(req)))));
router.put('/payroll/runs/:id/people/:employeeId/tds', ...editPay, handle((req) => tx(req, (db, c) => RUN.setTds(db, c, id(req), intParam(req.params.employeeId, 'employeeId'), req.body ?? {}, reqId(req)))));
router.delete('/payroll/runs/:id/people/:employeeId/tds', ...editPay, handle((req) => tx(req, (db, c) => RUN.clearTds(db, c, id(req), intParam(req.params.employeeId, 'employeeId'), reqId(req)))));
router.put('/payroll/items/:id', ...editPay, handle((req) => tx(req, (db, c) => RUN.updateItem(db, c, id(req), req.body ?? {}, reqId(req)))));
router.delete('/payroll/items/:id', ...removePay, handle((req) => tx(req, (db, c) => RUN.deleteItem(db, c, id(req), reqId(req)))));

router.get('/payroll/runs/:id/bank-file', ...viewPay, handle((req) => tx(req, (db, c) => RUN.bankFile(db, c, id(req), reqId(req)))));
router.get('/payroll/runs/:id/payslips', ...viewPay, handle((req) => RUN.runPayslips(pool, ctx(req), id(req), reqId(req))));
router.get('/payroll/payslips/:id/file', ...viewPay, handle((req) => tx(req, async (db, c) => {
  const p = await RUN.payslipRow(db, c, id(req));
  await PAY.auditSalaryRead(db, c, [p.employee_id], `payslip ${p.period_month}`, reqId(req));
  const buffer = await payslipPdf(p.snapshot, await letterheadOf(db, c.companyId));
  return { fileName: payslipFileName(p.snapshot), mimeType: 'application/pdf', contentBase64: buffer.toString('base64') };
})));

export default router;
