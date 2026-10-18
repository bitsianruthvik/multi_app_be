/**
 * planner3.js — STEP 5: Production › Planner, per production order at step level (services/plannerV3Service.js, the
 * pure engine plannerV3Engine.js; schema init.sql §84; contract TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Step 5").
 *
 *   GET  /planner3?mode=auto|manual&steps=1&po=<id>   the live plan (worked out on every read)
 *   PUT  /planner3/settings      { mode }                                   the stored mode
 *   PUT  /planner3/orders        { rows: [{ id, earliestStart, rank, pinned }] }   Management's inputs (only fields sent change)
 *   POST /planner3/run           { mode? }   SAVE the plan; the first save is the baseline
 *   POST /planner3/rebaseline    { note }    ask Management (approval type 'rebaseline') to make the saved plan the baseline
 *   GET  /planner3/health        plan health: the saved plan vs the baseline (Management › Overview)
 *
 * Production view sees the plan, production manage changes it; plan health is for production view or anyone in the
 * Management inbox.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx } from '../lib/http.js';
import { APPROVAL_PERMS } from '../services/approvalService.js';
import { getPlanner3, putSettings, putOrderInputs, savePlan, askRebaseline, planHealth } from '../services/plannerV3Service.js';

const router = Router();

router.get('/planner3', guard(PERM.productionView), handle((req) => getPlanner3(pool, ctx(req).companyId, req.query)));
router.get('/planner3/health', guardAny(PERM.productionView, ...APPROVAL_PERMS), handle((req) => planHealth(pool, ctx(req).companyId)));
router.put('/planner3/settings', guard(PERM.production), handle((req) => withTransaction((db) => putSettings(db, ctx(req), req.body ?? {}))));
router.put('/planner3/orders', guard(PERM.production), handle((req) => withTransaction((db) => putOrderInputs(db, ctx(req), req.body ?? {}))));
// The plan is worked out on the pool (side by side, outside the write), then written in one transaction.
router.post('/planner3/run', guard(PERM.production), handle((req) => withTransaction((db) => savePlan(db, ctx(req), req.body ?? {}, { reader: pool }))));
router.post('/planner3/rebaseline', guard(PERM.production), handle((req) => withTransaction((db) => askRebaseline(db, ctx(req), req.body ?? {}))));

export default router;
