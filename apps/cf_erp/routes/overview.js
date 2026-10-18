/**
 * overview.js — what the shell and Home read.
 *
 *   GET /nav-counts      live counts for the second nav row (+ pendingApprovals: what waits for THIS person, §73)
 *   GET /search?q=       records, orders, machines, batches … for the ⌘K palette
 *   GET /cockpit         Home: headline numbers and the work queues
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import { navCounts, search, cockpit } from '../services/overviewService.js';
import { pendingCount } from '../services/approvalService.js';

const router = Router();
router.get('/nav-counts', guard(PERM.view), handle(async (req) => {
  const companyId = ctx(req).companyId;
  const [counts, pendingApprovals] = await Promise.all([navCounts(pool, companyId), pendingCount(pool, companyId, (tag) => isPermitted(req.user, tag))]);
  return { ...counts, counts: { ...counts.counts, pendingApprovals } };
}));
router.get('/search', guard(PERM.view), handle((req) => search(pool, ctx(req).companyId, req.query.q)));
router.get('/cockpit', guard(PERM.view), handle((req) => cockpit(pool, ctx(req).companyId)));
export default router;
