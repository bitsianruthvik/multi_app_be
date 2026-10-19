/**
 * itr.js — "My tax › File my return" (TM/CF_HRMS_HIRING_SPEC.md §25.6, P4 the ITR helper, option A).
 *
 *   GET    /user/me/itr/years                  { years: [{ year, assessmentYear, dueDate, draft, payslipMonths, jsonAvailable … }] }
 *   GET    /user/me/itr/:year                  the draft (bank account masked) and the worked-out return
 *   PUT    /user/me/itr/:year                  { personal?, employer?, income?, deductions?, taxes?, bank?, choices? } — replaces the parts given
 *   POST   /user/me/itr/:year/finalise         keeps a snapshot of the employer part
 *   DELETE /user/me/itr/:year                  "Start again" — the draft is deleted
 *   GET    /user/me/itr/:year/summary.pdf      { fileName, mimeType, contentBase64 } — the summary laid out like the ITR schedules
 *   GET    /user/me/itr/:year/return.json      { fileName, mimeType, contentBase64 } — only when the year's official schema is
 *                                              vendored AND the output validates against it; else 409 NO_SCHEMA / 422 SCHEMA_INVALID
 *
 * PRIVATE TO THE PERSON. Like every /user/me route: gated on the self view only, and the
 * employee is the LOGIN's (hrms_employees.user_id), never an id from the request. There is
 * no HR or Owner way in — not here, not in any other router, not through the generic query
 * API (hrms_itr_returns is not in resourceDef.json). The Owner, holding every right, reaches
 * only their OWN return here. Nothing is filed or sent anywhere; the files are for the person
 * to upload on incometax.gov.in themselves.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx } from '../lib/http.js';
import { HrmsError, invalid } from '../lib/errors.js';
import { employeeIdOfLogin } from '../services/leave/requestService.js';
import { itrYears, myReturn, saveParts, finalise, removeReturn, fullReturn } from '../services/itr/itrService.js';
import { summaryPdf, summaryFileName } from '../services/itr/summaryPdf.js';
import { returnJson } from '../services/itr/itrJson.js';

const router = Router();

async function me(req) {
  const id = await employeeIdOfLogin(pool, ctx(req));
  if (!id) throw new HrmsError(403, 'NOT_LINKED', 'This login is not linked to an employee, so it has no return of its own.');
  return id;
}
const yearOf = (req) => {
  const y = String(req.params.year ?? '');
  if (!/^\d{4}-\d{2}$/.test(y)) throw invalid('INVALID', 'A tax year is written like 2025-26.');
  return y;
};
// Private: never cached by a browser or a proxy.
const noStore = (res) => res.set('Cache-Control', 'no-store');

router.get('/user/me/itr/years', guard(PERM.selfView), handle(async (req, res) => { noStore(res); return itrYears(pool, ctx(req), await me(req)); }));
router.get('/user/me/itr/:year', guard(PERM.selfView), handle(async (req, res) => { noStore(res); return myReturn(pool, ctx(req), await me(req), yearOf(req)); }));
router.put('/user/me/itr/:year', guard(PERM.selfView), handle(async (req, res) => {
  noStore(res);
  const id = await me(req);
  return withTransaction((db) => saveParts(db, ctx(req), id, yearOf(req), req.body ?? {}));
}));
router.post('/user/me/itr/:year/finalise', guard(PERM.selfView), handle(async (req, res) => {
  noStore(res);
  const id = await me(req);
  return withTransaction((db) => finalise(db, ctx(req), id, yearOf(req)));
}));
router.delete('/user/me/itr/:year', guard(PERM.selfView), handle(async (req) => {
  const id = await me(req);
  return withTransaction((db) => removeReturn(db, ctx(req), id, yearOf(req)));
}));
router.get('/user/me/itr/:year/summary.pdf', guard(PERM.selfView), handle(async (req, res) => {
  noStore(res);
  const full = await fullReturn(pool, ctx(req), await me(req), yearOf(req));
  const buffer = await summaryPdf(full);
  return { fileName: summaryFileName(full), mimeType: 'application/pdf', contentBase64: buffer.toString('base64') };
}));
router.get('/user/me/itr/:year/return.json', guard(PERM.selfView), handle(async (req, res) => {
  noStore(res);
  const full = await fullReturn(pool, ctx(req), await me(req), yearOf(req));
  const out = returnJson(full);
  return { fileName: out.fileName, mimeType: 'application/json', contentBase64: Buffer.from(JSON.stringify(out.json, null, 2)).toString('base64'), version: out.version };
}));

export default router;
