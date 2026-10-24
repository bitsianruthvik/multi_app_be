/**
 * gates.js — the steps that sit between a route's guard and its handler.
 * (TM/CF_HRMS_HIRING_SPEC.md §12.1 and §12.3.)
 *
 *   router.put('/positions/:id', guard(PERM.positions.edit), inPosition(), positionBody, handle(…))
 *
 * Three kinds, and a route reads like what it does:
 *   SCOPE    inPosition / inEmployee / departmentWrite … — the thing the request
 *            names must be inside the login's department (services/accessScope.js).
 *            For a login whose access covers the whole company each is a no-op.
 *   SHOWS    showsPeople / showsHiring — what the answer leaves out for somebody
 *            without contact or pay access (lib/redact.js).
 *   TAKES    takesEmployee / takesHiring — what a write does not read from them.
 *
 * Kept out of the handlers on purpose: a handler that forgets to ask is a hole
 * nobody sees, a route line without its gate is one anybody reading it can.
 */
import { pool } from './db.js';
import { step, can, need, PERM, canSeePay, canSeeContact, ctx } from './http.js';
import {
  assertPositionInScope, assertPositionBody, assertEmployeeInScope, assertDepartmentWrite, assertCompanyWide, scopeOf,
} from '../services/accessScope.js';
import { hideContactInPeople, dropContactFromEmployeeBody, hideInHiringAnswer, dropFromHiringBody, isPayPaper, isIdentityPaper } from './redact.js';

const byId = (req) => req.params.id;
/** A step, with the words the route table (ACCESS.md) prints for it. */
const named = (label, fn) => Object.assign(step(fn), { hrmsStep: label });

/* ── scope ───────────────────────────────────────────────────────────────── */

/** The position in the address — or the position a sub-row (`kind`) belongs to — must be inside the scope. */
export const inPosition = (kind = 'position', pick = byId) => named('scope: the position', (req) => assertPositionInScope(req, pick(req), kind));
/** The employee in the address — or the employee a sub-row (`kind`) belongs to. */
export const inEmployee = (kind = 'employee', pick = byId) => named('scope: the person', (req) => assertEmployeeInScope(req, pick(req), kind));
/** A new position: the department in the body must be inside. */
export const newPositionBody = named('scope: the org unit it is created in', (req) => assertPositionBody(req, req.body ?? {}, { creating: true }));
/** A position being changed: a department in the body must be inside. */
export const positionBody = named('scope: an org unit it is moved to', (req) => assertPositionBody(req, req.body ?? {}));
/** A department being added (`creating`) or changed. */
export const departmentWrite = ({ creating = false } = {}) => named('scope: the org unit', (req) => assertDepartmentWrite(req, creating ? null : req.params.id, req.body ?? {}));
/** Something that belongs to no department: not for a login scoped to one. */
export const companyWide = (sentence) => named('whole-company logins only', (req) => assertCompanyWide(req, sentence));
/** A work assignment named in a body: the person and the position must both be inside. */
export const assignmentBody = named('scope: the person and the position in the body', async (req) => {
  if (req.body?.employeeId != null) await assertEmployeeInScope(req, req.body.employeeId);
  if (req.body?.positionId != null) await assertPositionInScope(req, req.body.positionId);
  else if (!(await scopeOf(req)).all && req.method === 'POST') await assertCompanyWide(req, 'Choose a position inside your own org unit.');
});

/* ── shows / takes ───────────────────────────────────────────────────────── */

/** Runs the answer through `fn(req, body)` on its way out, when the request succeeded. */
const shows = (label, fn) => Object.assign((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body) => send(res.statusCode < 400 ? fn(req, body) : body);
  next();
}, { hrmsStep: label });

/** Employee reads: contact details only for somebody who may see them. */
export const showsPeople = shows('contact details only with cf_hrms_contact_view', (req, body) => (canSeeContact(req) ? body : hideContactInPeople(body)));
/** Hiring reads: the candidate's contact and the CTC, each for somebody who may see it. */
export const showsHiring = shows('pay only with cf_hrms_pay_view, the candidate’s contact only with cf_hrms_contact_view', (req, body) => hideInHiringAnswer(body, { pay: canSeePay(req), contact: canSeeContact(req) }));

/** An employee write from somebody who cannot see contact details leaves them as they are. */
export const takesEmployee = named('contact details are not written without cf_hrms_contact_view', (req) => { if (!canSeeContact(req)) dropContactFromEmployeeBody(req.body); });
/** A hiring write: no pay without pay access, no candidate contact without contact access. */
export const takesHiring = named('pay is not written without cf_hrms_pay_view', (req) => { dropFromHiringBody(req.body, { pay: canSeePay(req), contact: canSeeContact(req) }); });

/**
 * An employee's filed paper being opened. A scan of an identity paper shows the
 * number the identifiers list masks, and an appointment letter shows the pay:
 * the first needs contact access, the second pay access. Any other paper opens
 * with the right to see employees.
 */
export const employeePaper = named('an identity paper needs cf_hrms_contact_view, a pay paper cf_hrms_pay_view', async (req) => {
  if (can(req, PERM.contactView) && can(req, PERM.payView)) return;
  const [[doc]] = await pool.query(
    'SELECT document_type FROM hrms_employee_documents WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [ctx(req).companyId, Number(req.params.id) || 0],
  );
  if (!doc) return; // the service answers 404
  if (isPayPaper(doc.document_type)) need(req, PERM.payView);
  if (isIdentityPaper(doc.document_type)) need(req, PERM.contactView);
});

export default {
  inPosition, inEmployee, newPositionBody, positionBody, departmentWrite, companyWide, assignmentBody,
  showsPeople, showsHiring, takesEmployee, takesHiring, employeePaper,
};
