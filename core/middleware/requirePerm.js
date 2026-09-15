/**
 * requirePerm.js — one permission gate, shared by every app.
 *
 * Six fab_erp route files each hand-rolled this middleware, and two different
 * ways: most short-circuited on `role === 'admin'` before checking
 * `uiPermissions`, but `orderItems.js`'s copy did not — so an admin could
 * `POST /structure/apply` (gated by a copy that bypassed) and not
 * `POST /orders/:id/confirm` (gated by the copy that did not), for no reason
 * a person setting up roles could see. ADMIN BYPASSES EVERYWHERE is the
 * convention `mutateController` already applies; this makes every route agree
 * with it rather than with whichever copy it happened to inherit.
 *
 * `uiPermissions` is baked into the JWT at login and never refreshed — see
 * ARCHITECTURE.md "`usePermission` has no admin bypass" — so the backend bypass
 * is also what keeps an admin whose token predates a new grant from being
 * locked out of their own permission.
 */
import { logger } from '../utils/logger.js';

/**
 * The admin-bypass + uiPermissions check on its own, for a caller that needs
 * the decision but not the Express middleware shape — e.g. `routes/procurement.js`'s
 * `ctx()` helper, which resolves ids and checks permission in one place.
 */
export function isPermitted(user, tag) {
  if (user?.role && String(user.role).toLowerCase() === 'admin') return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
}

export const requirePerm = (tag) => (req, res, next) => {
  if (isPermitted(req.user, tag)) return next();
  return res.status(403).json({ error: 'FORBIDDEN', message: `Permission required: ${tag}` });
};

/**
 * One error responder, replacing the near-identical copy in templates.js and
 * resources.js.
 *
 * Never echoes `err.message` on a fallback 500 — an unexpected error's message
 * is often a driver/SQL detail, and the caller gets a generic sentence while
 * the real one goes to the log via `logger`, keyed on the error object so the
 * stack survives. A status the SERVICE set (403/404/409/…) is trusted instead:
 * that message was written for a person to read.
 *
 * `code`, `existing`, `problems`, `detail` and `readiness` are passed through
 * when the thrown error carries them — bomService's structured errors
 * (`ALREADY_BUILT`, `WORK_STARTED`, EU-9's `detail`/`readiness`) survive a
 * generic `fail(res, err)` call rather than needing a bespoke catch per route.
 */
export function fail(res, err, fallbackStatus = 500) {
  const status = err?.status || fallbackStatus;
  if (status >= 500) {
    logger.error({ err }, 'fab_erp: request failed');
    return res.status(status).json({ message: 'Something went wrong.' });
  }
  const body = { message: err?.message ?? 'Something went wrong.' };
  if (err?.code) body.code = err.code;
  if (err?.existing !== undefined) body.existing = err.existing;
  if (err?.problems) body.problems = err.problems;
  if (err?.detail) body.detail = err.detail;
  if (err?.readiness) body.readiness = err.readiness;
  return res.status(status).json(body);
}
