/**
 * people.js — employees, their statutory identifiers, their documents and their
 * employment-event history (plan §5.5, §7).
 *
 *   GET    /people/pickers                        contractors + identifier/document types + limits
 *   GET    /people/employees                      ?status=&employmentType=&contractorId=&search=&asOf=
 *   POST   /people/employees
 *   GET    /people/employees/:id                  record + its assignments + tab counts
 *   PUT    /people/employees/:id
 *   DELETE /people/employees/:id                  soft delete (created-in-error, NOT "left")
 *   GET    /people/employees/:id/assignments      READ-ONLY view of their jobs
 *
 *   GET    /people/employees/:id/identifiers      ?reveal=1   — see the PII note
 *   POST   /people/employees/:id/identifiers
 *   PUT    /people/identifiers/:id
 *   DELETE /people/identifiers/:id
 *
 *   GET    /people/employees/:id/documents
 *   POST   /people/employees/:id/documents        { documentType, fileName, mimeType, dataBase64, … }
 *   PUT    /people/documents/:id                  metadata + verification
 *   DELETE /people/documents/:id
 *   GET    /people/documents/:id/file             bytes, base64
 *
 *   GET    /people/employees/:id/events
 *   POST   /people/employees/:id/events
 *
 *   PUT    /people/employees/:id/photo            { fileName, mimeType, dataBase64 }
 *   GET    /people/employees/:id/photo
 *   DELETE /people/employees/:id/photo
 *
 * PII — THE ONE THING THIS FILE EXISTS FOR.
 * `hrms_employee_identifiers.identifier_value` is deliberately absent from
 * resourceDef.json, so the generic query API cannot select it under any filter.
 * That makes the identifier endpoints below the ONLY read path in the product,
 * and peopleService.listIdentifiers masks every value unless the caller both
 * asks (`?reveal=1`) and holds `cf_hrms_people_pii`. An unmasked read writes an
 * hrms_audit_log row naming who read which identifiers of whose — never the
 * numbers themselves. No route here logs a raw value or puts one in an error.
 *
 * WHY NOT THE GENERIC QUERY API FOR THE LIST. Relation joins in that engine are
 * single-hop, and an employee's department and location live two hops away
 * (employee → work assignment → department), because they are properties of the
 * WORK and not of the person. `listEmployees` resolves them from the primary
 * active assignment instead, which is the only place they are true.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam, dateParam, canSeePii } from '../lib/http.js';
import {
  listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee, assignmentsFor,
  listIdentifiers, createIdentifier, updateIdentifier, deleteIdentifier,
  listDocuments, addDocument, updateDocument, deleteDocument, readDocumentFile,
  listEvents, createEvent,
  setPhoto, readPhoto, deletePhoto,
  pickers,
} from '../services/peopleService.js';

const router = Router();

/** Every write is one transaction: the row, its employment event and its audit row land together. */
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
/** Express sets it when a trace id middleware is present; null is fine and expected. */
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;

// ── pickers ─────────────────────────────────────────────────────────────────

router.get('/people/pickers', guard(PERM.peopleView), handle((req) => pickers(pool, ctx(req).companyId)));

// ── employees ───────────────────────────────────────────────────────────────

router.get('/people/employees', guard(PERM.peopleView), handle((req) => (
  listEmployees(pool, ctx(req).companyId, req.query)
)));

router.post('/people/employees', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => createEmployee(db, c, req.body ?? {}, reqId(req)))
)));

router.get('/people/employees/:id', guard(PERM.peopleView), handle((req) => (
  getEmployee(pool, ctx(req).companyId, id(req), dateParam(req.query.asOf, 'asOf'))
)));

router.put('/people/employees/:id', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => updateEmployee(db, c, id(req), req.body ?? {}, reqId(req)))
)));

router.delete('/people/employees/:id', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => deleteEmployee(db, c, id(req), reqId(req)))
)));

/**
 * Their jobs, read-only.
 *
 * Gated on peopleView, not assignmentsManage: seeing that a person does three
 * jobs is part of seeing the person. Creating, changing or ending one belongs to
 * assignments.js and its own permission — this endpoint has no write twin.
 */
router.get('/people/employees/:id/assignments', guard(PERM.peopleView), handle((req) => (
  assignmentsFor(pool, ctx(req).companyId, id(req), dateParam(req.query.asOf, 'asOf'))
)));

// ── identifiers (PII) ───────────────────────────────────────────────────────

/**
 * Masked by default. `?reveal=1` asks for the real numbers and is honoured ONLY
 * for a caller holding cf_hrms_people_pii; for anyone else it returns exactly
 * what the default returns, with `masked: true`. A reveal that is honoured
 * writes the audit row.
 *
 * The values never travel in the URL, only in the response body — a query string
 * ends up in access logs, browser history and proxy traces.
 */
router.get('/people/employees/:id/identifiers', guard(PERM.peopleView), handle((req) => (
  listIdentifiers(pool, ctx(req), id(req), {
    reveal: req.query.reveal === '1' || req.query.reveal === 'true',
    canSeePii: canSeePii(req),
    requestId: reqId(req),
  })
)));

router.post('/people/employees/:id/identifiers', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => createIdentifier(db, c, id(req), req.body ?? {}, reqId(req)))
)));

router.put('/people/identifiers/:id', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => updateIdentifier(db, c, id(req), req.body ?? {}, reqId(req)))
)));

router.delete('/people/identifiers/:id', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => deleteIdentifier(db, c, id(req), reqId(req)))
)));

// ── documents ───────────────────────────────────────────────────────────────

router.get('/people/employees/:id/documents', guard(PERM.peopleView), handle((req) => (
  listDocuments(pool, ctx(req).companyId, id(req), dateParam(req.query.asOf, 'asOf'))
)));

router.post('/people/employees/:id/documents', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => addDocument(db, c, id(req), req.body ?? {}, reqId(req)))
)));

router.put('/people/documents/:id', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => updateDocument(db, c, id(req), req.body ?? {}, reqId(req)))
)));

router.delete('/people/documents/:id', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => deleteDocument(db, c, id(req), reqId(req)))
)));

/**
 * The file itself, as base64 in JSON rather than as a byte stream.
 *
 * The frontend's only sanctioned HTTP path (@core/api/client) attaches the JWT
 * and parses JSON; a raw byte response would have to be fetched around it, and
 * an <a href> download would arrive at the API with no Authorization header at
 * all. The browser rebuilds a Blob from this and opens or saves it.
 */
router.get('/people/documents/:id/file', guard(PERM.peopleView), handle((req) => (
  readDocumentFile(pool, ctx(req).companyId, id(req))
)));

// ── employment events ───────────────────────────────────────────────────────

router.get('/people/employees/:id/events', guard(PERM.peopleView), handle((req) => (
  listEvents(pool, ctx(req).companyId, id(req))
)));

/**
 * Only for what a service cannot know — a transfer agreed in a meeting, a
 * pre-system change. Everything a service DOES know (joining, exit, contractor
 * change) it writes itself, in the same transaction as the change. There is
 * deliberately no DELETE: a timeline you can edit backwards is not a history.
 */
router.post('/people/employees/:id/events', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => createEvent(db, c, id(req), req.body ?? {}, reqId(req)))
)));

// ── photo ───────────────────────────────────────────────────────────────────

router.put('/people/employees/:id/photo', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => setPhoto(db, c, id(req), req.body ?? {}, reqId(req)))
)));

router.get('/people/employees/:id/photo', guard(PERM.peopleView), handle((req) => (
  readPhoto(pool, ctx(req).companyId, id(req))
)));

router.delete('/people/employees/:id/photo', guard(PERM.peopleManage), handle((req) => (
  tx(req, (db, c) => deletePhoto(db, c, id(req), reqId(req)))
)));

export default router;
