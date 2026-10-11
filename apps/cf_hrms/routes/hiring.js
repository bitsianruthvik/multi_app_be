/**
 * hiring.js — filling a vacant position: job description, offer letter,
 * appointment. (TM/CF_HRMS_HIRING_SPEC.md §2.4 — paths and shapes are that
 * contract, exactly.)
 *
 *   GET    /hirings                          ?status=open|done|closed|all&positionId=   { hirings }
 *   GET    /hirings/:id                                                                 { hiring }
 *   POST   /positions/:id/hiring             {}                       starts at JD      { hiring }
 *          409 POSITION_FILLED · 409 HIRING_OPEN (existing.id / detail.hiringId) · 409 POSITION_CLOSED
 *   POST   /hirings/:id/confirm-jd           {}                       -> OFFER          { hiring }
 *          422 JD_NOT_READY only when the role has no purpose AND no KRA
 *   PUT    /hirings/:id                      candidate / terms fields, camelCase        { hiring }
 *          OFFER and APPOINTMENT only; 422 INVALID with problems[]
 *   POST   /hirings/:id/offer-letter         {}                       a new version     { hiring, letter, unfilled }
 *   POST   /hirings/:id/accept-offer         { acceptedOn? }          -> APPOINTMENT    { hiring }
 *   POST   /hirings/:id/appoint              { joiningDate, appointmentDate? } -> DONE
 *          { hiring, employee: { id, employeeCode, fullName }, assignmentId, letter, unfilled }
 *   POST   /hirings/:id/close                { reason, note? }        -> CLOSED         { hiring }
 *   GET    /hirings/:id/letters/:letterId/file                        { fileName, mimeType, contentBase64 }
 *   GET    /hirings/:id/jd/preview                                    { preview, readiness } — live at JD, the frozen copy after
 *   GET    /hirings/:id/jd/file          ?format=docx|pdf             the job description, in every stage, same shape
 *   GET    /hiring/close-reasons         ?hiringId=                   { groups: [{ label, reasons }] }
 *
 *   GET    /hiring/settings                                           { settings }
 *   PUT    /hiring/settings                  settings fields, camelCase                 { settings }
 *   GET    /hiring/templates                                          { templates }
 *   PUT    /hiring/templates/:kind           { fileName, contentBase64 }                { template, placeholders, unknown }
 *   GET    /hiring/templates/:kind/file                               { fileName, mimeType, contentBase64 }
 *   GET    /hiring/placeholders                                       { placeholders: [{ key, label, example }] }
 *
 * Reads: `cf_hrms_people_view`. Writes: `cf_hrms_people_manage`. The two
 * company-wide writes (settings, templates) need `cf_hrms_org_manage`.
 *
 * A hiring holds a candidate's phone, address and offered pay, so nothing here
 * is reachable with `cf_hrms_self_view` — an employee login gets 403 from every
 * route in this file, and none of it is exposed through the generic query API.
 *
 * EVERY WRITE IS ONE TRANSACTION, and for `appoint` that is the whole point:
 * the employee code, the employee, the assignment, the letter and the hiring's
 * DONE land together or not at all (services/hiringService.js).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listHirings, getHiring, startHiring, confirmJd, updateHiring,
  generateOfferLetter, acceptOffer, appoint, closeHiring,
  readLetterFile, readJdFile,
  getSettings, updateSettings, listTemplates, putTemplate, readTemplateFile, listPlaceholders,
  jdPreview, listCloseReasons,
} from '../services/hiringService.js';

const router = Router();

const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;

const read = guard(PERM.peopleView);
const write = guard(PERM.peopleManage);

// ── settings, templates, placeholders ───────────────────────────────────────

router.get('/hiring/settings', read, handle((req) => getSettings(pool, ctx(req).companyId)));
router.put('/hiring/settings', guard(PERM.orgManage), handle((req) => (
  tx(req, (db, c) => updateSettings(db, c, req.body ?? {}, reqId(req)))
)));

router.get('/hiring/templates', read, handle((req) => listTemplates(pool, ctx(req).companyId)));
router.put('/hiring/templates/:kind', guard(PERM.orgManage), handle((req) => (
  tx(req, (db, c) => putTemplate(db, c, req.params.kind, req.body ?? {}, reqId(req)))
)));
router.get('/hiring/templates/:kind/file', read, handle((req) => readTemplateFile(pool, ctx(req).companyId, req.params.kind)));

router.get('/hiring/placeholders', read, handle(async () => listPlaceholders()));
// The reasons a hiring may be closed with — all of them, or with ?hiringId= those that apply to it as it stands.
router.get('/hiring/close-reasons', read, handle((req) => listCloseReasons(pool, ctx(req).companyId, req.query.hiringId)));

// ── hirings ─────────────────────────────────────────────────────────────────

router.get('/hirings', read, handle((req) => listHirings(pool, ctx(req).companyId, req.query)));
router.get('/hirings/:id', read, handle((req) => getHiring(pool, ctx(req).companyId, id(req))));

router.post('/positions/:id/hiring', write, handle((req) => tx(req, (db, c) => startHiring(db, c, id(req), reqId(req)))));

router.post('/hirings/:id/confirm-jd', write, handle((req) => tx(req, (db, c) => confirmJd(db, c, id(req), reqId(req)))));
router.put('/hirings/:id', write, handle((req) => tx(req, (db, c) => updateHiring(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/hirings/:id/offer-letter', write, handle((req) => tx(req, (db, c) => generateOfferLetter(db, c, id(req), reqId(req)))));
router.post('/hirings/:id/accept-offer', write, handle((req) => tx(req, (db, c) => acceptOffer(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/hirings/:id/appoint', write, handle((req) => tx(req, (db, c) => appoint(db, c, id(req), req.body ?? {}, reqId(req)))));
router.post('/hirings/:id/close', write, handle((req) => tx(req, (db, c) => closeHiring(db, c, id(req), req.body ?? {}, reqId(req)))));

router.get('/hirings/:id/letters/:letterId/file', read, handle((req) => (
  readLetterFile(pool, ctx(req).companyId, id(req), intParam(req.params.letterId, 'letterId'))
)));
// The job description: what will be (or was) frozen, and its file — ?format=docx|pdf, in every stage.
router.get('/hirings/:id/jd/preview', read, handle((req) => jdPreview(pool, ctx(req), id(req))));
router.get('/hirings/:id/jd/file', read, handle((req) => readJdFile(pool, ctx(req), id(req), req.query.format)));

export default router;
