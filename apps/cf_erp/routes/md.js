/**
 * md.js — the MD's page, the weekly reports and the company settings (init.sql §113).
 *
 *   GET  /md/me                     { md, standIn } — is this person the MD, or standing in for the MD right now
 *   GET  /md/overview               decisions, reports to verify, the MD's alerts, the departments strip
 *   GET  /md/reports/:id            one weekly report in full
 *   POST /md/reports/:id/seen       { note? } — verified: the name and the time are kept
 *   GET  /settings                  every setting, grouped, with its value and default
 *   PUT  /settings                  { values: { key: value } }
 *
 * The MD is whoever holds cf_erp_md_dashboard (the three older tags still pass). The stand-in (settings
 * md_standin_user + md_standin_on) passes every guard as the MD does — lib/http.js adds the MD's tags to the request.
 * Settings are the MD's and Setup's; a stand-in does not change them.
 */
import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam, standIn } from '../lib/http.js';
import { DEPARTMENTS } from '../services/alertService.js';
import { mdOverview, getReport, markSeen } from '../services/mdOverviewService.js';
import { settingsPage, saveSettings, isStandIn } from '../services/settingsService.js';

const router = Router();
const can = (req) => (tag) => isPermitted(req.user, tag);
const md = guardAny(...DEPARTMENTS.md);
const id = (req) => intParam(req.params.id);

router.get('/md/me', protect, standIn, handle(async (req) => ({
  md: DEPARTMENTS.md.some((t) => isPermitted(req.user, t)),
  standIn: await isStandIn(pool, ctx(req).companyId, ctx(req).userId),
})));
router.get('/md/overview', md, handle((req) => mdOverview(pool, ctx(req).companyId, can(req), ctx(req).userId)));
router.get('/md/reports/:id', md, handle((req) => getReport(pool, ctx(req).companyId, id(req))));
router.post('/md/reports/:id/seen', md, handle((req) => withTransaction((db) => markSeen(db, ctx(req), id(req), req.body ?? {}))));

// Settings: read by the MD and Setup; a stand-in's borrowed tags do not open them (req.standIn is set by lib/http.js).
const own = (req, res, next) => (req.standIn && String(req.user?.role ?? '').toLowerCase() !== 'admin'
  ? res.status(403).json({ error: 'FORBIDDEN', message: 'Settings are changed by the MD, not by a stand-in.' }) : next());
router.get('/settings', guardAny('cf_erp_md_dashboard', PERM.setup), handle((req) => settingsPage(pool, ctx(req).companyId)));
router.put('/settings', guardAny('cf_erp_md_dashboard', PERM.setup), own, handle((req) => withTransaction((db) => saveSettings(db, ctx(req), req.body ?? {}))));

export default router;
