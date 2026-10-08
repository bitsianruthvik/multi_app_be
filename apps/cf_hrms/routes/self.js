/**
 * self.js — the employee self view. One endpoint, one permission, no ids.
 *
 *   GET /user/me/place   ?on=YYYY-MM-DD   gated on `cf_hrms_self_view`
 *
 * It sits under `/user/` to match the platform's own URL shape
 * (`/api/:companySlug/:appSlug/user/*` is "authenticated user endpoints" —
 * CLAUDE.md), and `me` rather than `:id` is the whole security design: there is
 * no identifier in this path, so there is nothing for a caller to substitute.
 * The employee is found by `req.user.id` → `hrms_employees.user_id`.
 *
 * ── THIS FILE MUST STAY ONE ROUTE LONG ────────────────────────────────────
 * `cf_hrms_self_view` is the only tag a shop-floor login holds, and the only
 * thing it may ever buy is the caller's own place in the organisation. Every
 * useful-sounding addition breaks that:
 *
 *   - a `?employeeId=` parameter turns it into a people directory;
 *   - a "my team's attendance" route turns it into the attendance screen with
 *     a different gate, which is what `cf_hrms_attendance_view` is for;
 *   - a lookup by employee code is the same disclosure with extra steps.
 *
 * A supervisor who genuinely needs their team's attendance gets
 * `cf_hrms_attendance_view` granted to their role. That is the mechanism; this
 * is not.
 *
 * ── PII ───────────────────────────────────────────────────────────────────
 * `canSeePii` is passed in as a SHAPE decision, not an access decision — the
 * same pattern `people.js` uses. Without `cf_hrms_people_pii` the caller still
 * gets a complete answer, with their own contact details (their own data) and
 * everybody else as a name and a job. Statutory identifiers are not in this
 * payload at any permission level; `people.js` is the sole read path for those
 * and it audits every unmasked read.
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx, dateParam, canSeePii } from '../lib/http.js';
import { myPlace } from '../services/selfService.js';

const router = Router();

/**
 * Who I am, who I report into, who is on my team, what I am responsible for.
 *
 * `on` exists because every read in this app is "as of a date" — a person
 * looking at their place last month is a fair question and the resolvers all
 * take it. It changes which effective-dated rows resolve; it cannot change
 * WHOSE rows they are.
 */
router.get('/user/me/place', guard(PERM.selfView), handle((req) => myPlace(
  pool,
  ctx(req),
  { on: dateParam(req.query.on), canSeePii: canSeePii(req) },
)));

export default router;
