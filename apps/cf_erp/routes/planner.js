/**
 * planner.js — Production › Plan (services/plannerService.js; contract in
 * TM/CF_ERP_PLANNER_PLAN.md §2, schema init.sql §31).
 *
 *   GET /planner?from=YYYY-MM-DD       the whole snapshot: horizon and periods,
 *                                      functions and capacity, orders and lines,
 *                                      units at every level, supply, entries
 *   PUT /planner/entries               { entries: [{ unitKey, shipDate|null, pinned }] }
 *   PUT /planner/changes               { entries: [...], ranks: [{ lineId, unitKeys }] } — the
 *                                      Save button: entries + each line's unit order (§38), one transaction
 *   PUT /planner/priorities            { orderIds: [...] }  (the whole ranking)
 *   PUT /planner/lines/:id/level       { level: 'line' | '0' | '1' … | null }
 *   PUT /planner/targets               { 'YYYY-MM': tonnes | null }
 *   PUT /planner/settings              { minLinesPerMonth?, allowPartialLines? }
 *
 * Grants are production's: cf_erp_production_view to see the plan,
 * cf_erp_production_manage to change it. Every write is one transaction and
 * returns what it changed.
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import { getPlanner, putEntries, putChanges, putPriorities, putLineLevel, putTargets, putSettings } from '../services/plannerService.js';

const router = Router();

router.get('/planner', guard(PERM.productionView),
  handle((req) => getPlanner(pool, ctx(req).companyId, { from: req.query.from })));
router.put('/planner/entries', guard(PERM.production),
  handle((req) => withTransaction((db) => putEntries(db, ctx(req), req.body ?? {}))));
router.put('/planner/changes', guard(PERM.production),
  handle((req) => withTransaction((db) => putChanges(db, ctx(req), req.body ?? {}))));
router.put('/planner/priorities', guard(PERM.production),
  handle((req) => withTransaction((db) => putPriorities(db, ctx(req), req.body ?? {}))));
router.put('/planner/lines/:id/level', guard(PERM.production),
  handle((req) => withTransaction((db) => putLineLevel(db, ctx(req), intParam(req.params.id, 'id'), req.body ?? {}))));
router.put('/planner/targets', guard(PERM.production),
  handle((req) => withTransaction((db) => putTargets(db, ctx(req), req.body ?? {}))));
router.put('/planner/settings', guard(PERM.production),
  handle((req) => withTransaction((db) => putSettings(db, ctx(req), req.body ?? {}))));

export default router;
