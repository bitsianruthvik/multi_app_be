/**
 * selfAttendance.js — My attendance, and a manager's team (TM/CF_HRMS_HIRING_SPEC.md §28.5, §28.7).
 * Gated on the self view like every /user/me route; the person is the login's employee, never an
 * id from the client. A manager's team is the §7 rule (teamScopeService.assertPersonInMyTeam): the
 * people in positions below them, today — never their own, a card-mate's or a manager's.
 *
 *   GET  /user/me/attendance?month=                     my month: days, punches, penalties, requests, the policy, web punch
 *   POST /user/me/attendance/punch { direction, lat?, lng? }   the web punch (when the company turned it on)
 *   POST /user/me/attendance/requests { kind, date, … }        correct a day · short permission · on duty
 *   POST /user/me/attendance/requests/:id/cancel
 *   GET  /user/me/team/attendance?month=                the team calendar (muster of the people below me)
 *   GET  /user/me/team/attendance/:id?month=            one of them
 *   POST /user/me/team/attendance/penalties/:id/waive { note }
 *
 * The approvals of kind ATTENDANCE are in routes/self.js (the kinds registry).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { HrmsError } from '../lib/errors.js';
import { employeeIdOfLogin } from '../services/leave/requestService.js';
import { assertPersonInMyTeam } from '../services/teamScopeService.js';
import { loadMySlice } from '../services/selfOrgChartService.js';
import { personMonth, monthGrid } from '../services/attendance/reads.js';
import { submitMine, cancelMine } from '../services/attendance/requests.js';
import { webPunch } from '../services/attendance/punches.js';
import { waivePenalty, penaltyEmployeeId } from '../services/attendance/penalties.js';
import rateLimit from 'express-rate-limit';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const reqId = (req) => req.id ?? req.headers['x-request-id'] ?? null;

async function me(req) {
  const id = await employeeIdOfLogin(pool, ctx(req));
  if (!id) throw new HrmsError(403, 'NOT_LINKED', 'This login is not linked to an employee, so it has no attendance of its own.');
  return id;
}

/** The people below me today (occupants of the positions that report to mine). */
async function myTeamIds(req) {
  const slice = await loadMySlice(pool, ctx(req), {});
  if (!slice.linked) return [];
  const ids = new Set();
  for (const n of slice.graph.nodes) if (slice.canChange(n.id)) for (const o of n.occupants ?? []) ids.add(o.employeeId);
  ids.delete(slice.employee.id);
  return [...ids];
}

// A person punches a few times a day; ten a minute is plenty and stops a stuck button.
const punchLimit = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user?.id ?? 'x'}`, validate: false,
  message: { code: 'TOO_MANY', message: 'Too many punches in a minute. Wait a moment.' } });

router.get('/user/me/attendance', guard(PERM.selfView), handle(async (req) => personMonth(pool, ctx(req), await me(req), { month: req.query.month })));
router.post('/user/me/attendance/punch', guard(PERM.selfView), punchLimit, handle(async (req) => {
  const employeeId = await me(req);
  return tx(req, (db, c) => webPunch(db, c, employeeId, req.body ?? {}, req.ip));
}));
router.post('/user/me/attendance/requests', guard(PERM.selfView), handle((req) => tx(req, (db, c) => submitMine(db, c, req.body ?? {}, reqId(req)))));
router.post('/user/me/attendance/requests/:id/cancel', guard(PERM.selfView), handle((req) => tx(req, (db, c) => cancelMine(db, c, intParam(req.params.id), reqId(req)))));

router.get('/user/me/team/attendance', guard(PERM.selfView), handle(async (req) => {
  const ids = await myTeamIds(req);
  return { ...(await monthGrid(pool, ctx(req), { month: req.query.month, employeeIds: ids })), team: ids.length };
}));
router.get('/user/me/team/attendance/:id', guard(PERM.selfView), handle(async (req) => {
  await assertPersonInMyTeam(pool, ctx(req), intParam(req.params.id));
  return personMonth(pool, ctx(req), intParam(req.params.id), { month: req.query.month });
}));
router.post('/user/me/team/attendance/penalties/:id/waive', guard(PERM.selfView), handle(async (req) => {
  const employeeId = await penaltyEmployeeId(pool, ctx(req).companyId, intParam(req.params.id));
  if (!employeeId) throw new HrmsError(404, 'NOT_FOUND', 'That penalty not found.');
  await assertPersonInMyTeam(pool, ctx(req), employeeId);
  const mine = await me(req);
  return tx(req, (db, c) => waivePenalty(db, { ...c, employeeId: mine }, intParam(req.params.id), req.body ?? {}, reqId(req)));
}));

export default router;
