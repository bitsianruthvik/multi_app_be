/**
 * redact.js — what a read leaves out, and what a write does not take, for a
 * person without `cf_hrms_contact_view` or `cf_hrms_pay_view`.
 * (TM/CF_HRMS_HIRING_SPEC.md §12.1.)
 *
 * REMOVED ON THE SERVER, never hidden by the screen. Pure functions over the
 * shapes the services return; lib/gates.js puts them on the routes.
 *
 *   CONTACT  phone, email, address, emergency contact, date of birth, the login's
 *            email; a hiring's candidate phone, email, address and date of birth.
 *            The answer carries `contactHidden: true` where something was removed.
 *   PAY      a hiring's annual CTC (null, with `payHidden: true`); and — because
 *            the offer letter is made from it — `can.generateOffer` is false.
 *
 * A WRITE FROM SOMEBODY WHO CANNOT SEE A VALUE DOES NOT TOUCH IT. A form that
 * was shown a blank sends a blank back; taken at its word it would erase the
 * phone number or the salary the person was never shown. Those keys are
 * dropped from the body before the service reads it.
 */

const EMPLOYEE_CONTACT = ['phone', 'email', 'dateOfBirth', 'addressJson', 'emergencyContactJson', 'userEmail'];
const EMPLOYEE_CONTACT_BODY = ['phone', 'email', 'dateOfBirth', 'address', 'addressJson', 'emergencyContact', 'emergencyContactJson'];

const blanked = (obj, keys) => {
  const out = { ...obj };
  for (const k of keys) if (k in out) out[k] = null;
  return out;
};

/** One employee as a list row or a detail's `employee`. */
export const hideEmployeeContact = (e) => (e && typeof e === 'object' ? { ...blanked(e, EMPLOYEE_CONTACT), contactHidden: true } : e);

/**
 * Any answer of the people routes: { employee }, { items: [...] }, or one that
 * has neither (left as it is). `contact: 'HIDDEN'` is the word the org chart
 * panel already reads.
 */
export function hideContactInPeople(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (out.employee && typeof out.employee === 'object' && ('phone' in out.employee || 'email' in out.employee)) {
    out.employee = hideEmployeeContact(out.employee);
    out.contact = 'HIDDEN';
  }
  if (Array.isArray(out.items)) out.items = out.items.map((row) => ('phone' in row || 'email' in row ? hideEmployeeContact(row) : row));
  return out;
}

/** The keys of an employee body a person without contact access may not set. */
export function dropContactFromEmployeeBody(body) {
  if (!body || typeof body !== 'object') return body;
  for (const k of EMPLOYEE_CONTACT_BODY) delete body[k];
  return body;
}

/** One full hiring ({ candidate, terms, can … }). A summary row has neither and is returned as it is. */
function hideInHiring(h, { pay, contact }) {
  if (!h || typeof h !== 'object') return h;
  const out = { ...h };
  if (!contact && out.candidate && typeof out.candidate === 'object') {
    out.candidate = { ...out.candidate, phone: null, email: null, address: null, dateOfBirth: null };
    out.contactHidden = true;
  }
  if (!pay && out.terms && typeof out.terms === 'object') {
    out.terms = { ...out.terms, annualCtc: null };
    out.payHidden = true;
    // The letters are made from the CTC: not theirs to make, and "the annual CTC is missing" is not theirs to be told.
    if (out.can && typeof out.can === 'object') out.can = { ...out.can, generateOffer: false };
    if (out.missing?.offerLetter) out.missing = { ...out.missing, offerLetter: out.missing.offerLetter.filter((m) => !/CTC/i.test(m)) };
  }
  return out;
}

/** Any answer of the hiring routes: { hiring }, with whatever else beside it. */
export function hideInHiringAnswer(body, flags) {
  if (!body || typeof body !== 'object' || (flags.pay && flags.contact)) return body;
  if (body.hiring && typeof body.hiring === 'object') return { ...body, hiring: hideInHiring(body.hiring, flags) };
  return body;
}

/** The keys of a hiring body a person may not set: pay without pay access, the candidate's contact without contact access. */
export function dropFromHiringBody(body, { pay, contact }) {
  if (!body || typeof body !== 'object') return body;
  if (!pay) {
    delete body.annualCtc;
    if (body.terms && typeof body.terms === 'object') delete body.terms.annualCtc;
  }
  if (!contact) {
    for (const k of ['candidatePhone', 'candidateEmail', 'candidateAddress', 'candidateDateOfBirth']) delete body[k];
    if (body.candidate && typeof body.candidate === 'object') for (const k of ['phone', 'email', 'address', 'dateOfBirth']) delete body.candidate[k];
  }
  return body;
}

/**
 * An employee's filed documents, by what the paper shows. Matched on the
 * document type without case, spaces or signs, so "Appointment letter",
 * "APPOINTMENT_LETTER" and "Signed appointment letter" are one thing.
 */
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PAY_PAPERS = ['appointmentletter', 'offerletter', 'contract', 'salary', 'payslip', 'ctc', 'increment', 'bankdetails'];
const IDENTITY_PAPERS = ['aadhaar', 'aadhar', 'pan', 'passport', 'drivinglicence', 'drivinglicense', 'voterid', 'photoid', 'uan', 'esi', 'pf'];
export const isPayPaper = (documentType) => { const t = squash(documentType); return PAY_PAPERS.some((p) => t.includes(p)); };
export const isIdentityPaper = (documentType) => { const t = squash(documentType); return IDENTITY_PAPERS.some((p) => t === p || t.startsWith(p) || t.endsWith(p)); };

export default {
  hideEmployeeContact, hideContactInPeople, dropContactFromEmployeeBody, hideInHiringAnswer, dropFromHiringBody, isPayPaper, isIdentityPaper,
};
