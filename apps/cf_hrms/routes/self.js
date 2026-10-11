/**
 * self.js — the employee self view. Two endpoints, one permission, no ids.
 *
 *   GET /user/me/place      ?on=YYYY-MM-DD   gated on `cf_hrms_self_view`
 *   GET /user/me/orgchart   ?on=YYYY-MM-DD   gated on `cf_hrms_self_view` (2026-10-09)
 *
 * It sits under `/user/` to match the platform's own URL shape
 * (`/api/:companySlug/:appSlug/user/*` is "authenticated user endpoints" —
 * CLAUDE.md), and `me` rather than `:id` is the whole security design: there is
 * no identifier in this path, so there is nothing for a caller to substitute.
 * The employee is found by `req.user.id` → `hrms_employees.user_id`.
 *
 * ── THIS FILE ONLY EVER ANSWERS ABOUT "ME" ────────────────────────────────
 * `cf_hrms_self_view` is the only tag a shop-floor login holds, and the only
 * thing it may ever buy is the caller's own place in the organisation. The
 * second route, `/me/orgchart`, is that same place drawn as a chart: the
 * caller's managers up to the top, their own seats, their branch below and
 * their dotted-line managers — computed server-side from the caller's own
 * seats, field-whitelisted, never the whole graph (selfOrgChartService.js).
 * It takes no id either. Every other useful-sounding addition breaks the rule:
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
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, dateParam, canSeePii, intParam } from '../lib/http.js';
import { myPlace } from '../services/selfService.js';
import { myOrgChart } from '../services/selfOrgChartService.js';
import {
  teamJobContent, teamAddLine, teamChangeLine, teamSwitchOffLine, teamUndoLine, teamShifts, teamChangeShift,
} from '../services/teamScopeService.js';

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

/**
 * My slice of the org chart. The company graph is read server-side and cut to
 * the caller's slice before anything leaves; `/orgchart` itself stays on
 * `cf_hrms_org_view`, and this tag must never be added to its guard.
 */
router.get('/user/me/orgchart', guard(PERM.selfView), handle((req) => myOrgChart(
  pool,
  ctx(req),
  { on: dateParam(req.query.on) },
)));

/**
 * WHAT AN EMPLOYEE LOGIN MAY CHANGE (spec §7): for the positions BELOW them —
 * and for no other — the position's responsibilities and KPIs, and its shift.
 *
 *   GET    /user/me/team/positions/:id/job-content            = GET  /positions/:id/job-content
 *   POST   /user/me/team/positions/:id/job-content/add        = POST /positions/:id/job-content/add
 *   POST   /user/me/team/positions/:id/job-content/change       …/change
 *   POST   /user/me/team/positions/:id/job-content/switch-off   …/switch-off
 *   POST   /user/me/team/positions/:id/job-content/undo         …/undo
 *   GET    /user/me/team/shifts                               { shifts: [{ id, code, name, summary }] }
 *   PUT    /user/me/team/positions/:id/shift  { shiftId }     = PUT  /positions/:id with defaultShiftId only
 *
 * Gated on the one self tag, like everything in this file — and then on THE
 * RULE, which services/teamScopeService.js runs on every call from the
 * caller's own employee and position (never from anything the client sends):
 * outside it, 403 NOT_YOUR_TEAM. Each write calls the same service function the
 * HR route calls, so validation, the KRA refusal and the audit row are the same.
 */
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const positionId = (req) => intParam(req.params.id);

router.get('/user/me/team/shifts', guard(PERM.selfView), handle((req) => teamShifts(pool, ctx(req))));
router.get('/user/me/team/positions/:id/job-content', guard(PERM.selfView), handle((req) => (
  teamJobContent(pool, ctx(req), positionId(req), { on: dateParam(req.query.on) })
)));
router.post('/user/me/team/positions/:id/job-content/add', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamAddLine(db, c, positionId(req), req.body ?? {}))));
router.post('/user/me/team/positions/:id/job-content/change', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamChangeLine(db, c, positionId(req), req.body ?? {}))));
router.post('/user/me/team/positions/:id/job-content/switch-off', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamSwitchOffLine(db, c, positionId(req), req.body ?? {}))));
router.post('/user/me/team/positions/:id/job-content/undo', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamUndoLine(db, c, positionId(req), req.body ?? {}))));
router.put('/user/me/team/positions/:id/shift', guard(PERM.selfView), handle((req) => tx(req, (db, c) => teamChangeShift(db, c, positionId(req), req.body ?? {}))));

export default router;
