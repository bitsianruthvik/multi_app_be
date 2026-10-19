import { protect } from '../../../core/middleware/authmiddleware.js';
import { fail } from '../../../core/middleware/requirePerm.js';
import { HrmsError, translateDbError } from './errors.js';
import { AREAS, NAMED, areaTag, isKnownTag } from './access.js';
import { accessOf } from './accessContext.js';

/**
 * THE RIGHTS, as the routes name them. (TM/CF_HRMS_HIRING_SPEC.md §12.1; the
 * catalogue itself is lib/access.js.)
 *
 *   PERM.positions.edit        'cf_hrms_positions_edit'      nine areas × view / edit / remove / upload
 *   PERM.payView               'cf_hrms_pay_view'            seven named rights
 *   PERM.signedIn                                            any login with access to this app
 *
 * A right that does not exist (employees.remove, hiring.upload …) is simply not
 * a property: `guard(PERM.hiring.remove)` is `guard(undefined)`, which throws
 * when the router is built, not when somebody calls it.
 *
 * Two of them do not open a route, they change what a route RETURNS:
 * `contactView` (phone, email, address, statutory identifiers in full) and
 * `payView` (CTC and everything made from it). See lib/redact.js.
 *
 * `selfView` is the odd one in the other direction: the ONLY tag that grants a
 * person something about THEMSELVES rather than about the company. It gates the
 * /user/me/* routes and nothing else in this app checks it. It must never be
 * added to another route's `guard(...)`, and no route gated on another tag may
 * fall back to it: the whole security boundary of the self view is that the
 * employee id comes from `req.user.id` via `hrms_employees.user_id` and is
 * never accepted from the client.
 */
export const PERM = Object.freeze({
  ...Object.fromEntries(AREAS.map((a) => [a.key, Object.freeze(Object.fromEntries(a.rights.map((r) => [r, areaTag(a.key, r)])))])),
  ...Object.fromEntries(NAMED.map((n) => [n.key, n.tag])),
  /** Not a tag: any login that has access to this app. */
  signedIn: '@signed-in',
});

/** The tenant and user of a request. The company always comes from the token, never the URL. */
export function ctx(req) {
  const companyId = Number(req.user?.companyId ?? req.user?.company_id);
  if (!companyId) throw new HrmsError(401, 'NO_COMPANY', 'This session has no company.');
  const userId = Number(req.user?.id) || null;
  // `owner`: may date a job-content change in the past, with a reason (spec §16.1).
  // Only meaningful after guard(...) has run; false everywhere else.
  return { companyId, userId, owner: Boolean(req.hrmsAccess?.owner) };
}

/**
 * Does this request hold the right? The Owner (the company's `admin` role, by
 * the role this app's access row points at NOW — lib/accessContext.js) holds
 * every one. Only meaningful after `guard(...)` has run.
 */
export function can(req, tag) {
  if (req.hrmsAccess?.owner) return true;
  return Array.isArray(req.user?.uiPermissions) && req.user.uiPermissions.includes(tag);
}

/** What a person is told when a right is missing, where a sentence is better than a tag. */
const REFUSAL = {
  [PERM.payView]: ['PAY_HIDDEN', 'You do not have access to pay, so this cannot be opened or made here.'],
  [PERM.contactView]: ['CONTACT_HIDDEN', 'You do not have access to contact details.'],
};
const forbidden = (tags) => {
  const [code, message] = (tags.length === 1 && REFUSAL[tags[0]]) || ['FORBIDDEN', `Permission required: ${tags.join(' or ')}`];
  const err = new HrmsError(403, code, message);
  err.error = 'FORBIDDEN';
  return err;
};

/** For a route whose right depends on what is in the request. Throws 403. */
export function need(req, tag) {
  if (!can(req, tag)) throw forbidden([tag]);
}
/** The old name; same thing. */
export const assertPerm = need;

/** Shape decisions, not access decisions: what a read may include. */
export const canSeeContact = (req) => can(req, PERM.contactView);
export const canSeePay = (req) => can(req, PERM.payView);
/** The old name of canSeeContact (`cf_hrms_people_pii` became `cf_hrms_contact_view`). */
export const canSeePii = canSeeContact;

/**
 * THE GUARD. `protect`, then the right.
 *
 *   guard(PERM.positions.edit)                         that right
 *   guard([PERM.setup.view, PERM.positions.view])      ANY of these (a picker two screens share)
 *   guard(PERM.hiring.view, { also: [PERM.payView] })  that right AND each of `also`
 *   guard(PERM.signedIn)                               any login with access to the app
 *   { note }                                           words for the route table: a right the handler asks for itself
 *
 * What it asks for is kept on the middleware (`hrmsGuard`), so the route table
 * (ACCESS.md) and the test that no route is unguarded read the routers
 * themselves — not a list somebody has to remember to update.
 */
export function guard(tags, { also = [], note = null } = {}) {
  const signedIn = tags === PERM.signedIn;
  const anyOf = signedIn ? [] : (Array.isArray(tags) ? tags : [tags]);
  for (const t of [...anyOf, ...also]) {
    if (!isKnownTag(t)) throw new Error(`[cf_hrms] guard(): "${t}" is not a right of this app (lib/access.js).`);
  }
  if (!signedIn && !anyOf.length) throw new Error('[cf_hrms] guard(): name a right, or PERM.signedIn.');

  const check = async (req, res, next) => {
    try {
      // A service token is nobody in particular: it holds no right here.
      const access = await accessOf(req);
      if (!access) return res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'You do not have access to this app' });
      req.hrmsAccess = access;
      if (!access.owner) {
        if (anyOf.length && !anyOf.some((t) => can(req, t))) throw forbidden(anyOf);
        for (const t of also) if (!can(req, t)) throw forbidden([t]);
      }
      return next();
    } catch (err) {
      if (err instanceof HrmsError && err.status === 403) {
        return res.status(403).json({ error: 'FORBIDDEN', code: err.code, message: err.message });
      }
      return fail(res, err);
    }
  };
  check.hrmsGuard = Object.freeze({ signedIn, anyOf: Object.freeze([...anyOf]), also: Object.freeze([...also]), note });
  return [protect, check];
}

/** Wraps an async handler: its return value is the JSON body; errors go through fail(). */
export const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    fail(res, translateDbError(err));
  }
};

/**
 * A step between the guard and the handler that may refuse (lib/…, services/accessScope.js):
 * `step(async (req) => { … throw … })`. Errors answer exactly as a handler's do.
 */
export const step = (fn) => async (req, res, next) => {
  try {
    await fn(req);
    next();
  } catch (err) {
    fail(res, translateDbError(err));
  }
};

/** Positive integer from a route param or body field, or a 422. */
export function intParam(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HrmsError(422, 'INVALID', `${name} must be a positive whole number.`);
  return n;
}

/**
 * An ISO date (YYYY-MM-DD) from a query param, or today. Almost every read in
 * this app is "as of a date" — active assignments, effective role content,
 * reporting lines — so the parsing lives here rather than in eleven routers.
 */
export function dateParam(value, name = 'on') {
  if (value === undefined || value === null || value === '') {
    // The server's local date, as every write's "today" is (positionService.today):
    // a UTC date here made a change written after local midnight invisible until UTC caught up.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new HrmsError(422, 'INVALID', `${name} must be a date as YYYY-MM-DD.`);
  }
  return s;
}

/** `view` on any area: what a picker shared by every screen asks for. */
export const ANY_VIEW = Object.freeze(AREAS.map((a) => areaTag(a.key, 'view')));
