/**
 * overview.js — what the shell and Home read.
 *
 *   GET /nav-counts      live counts for the second nav row
 *   GET /search?q=       records, orders, machines, batches … for the ⌘K palette
 *   GET /cockpit         Home: headline numbers and the work queues
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, handle, ctx } from '../lib/http.js';
import { navCounts, search, cockpit } from '../services/overviewService.js';

const router = Router();
router.get('/nav-counts', guard(PERM.view), handle((req) => navCounts(pool, ctx(req).companyId)));
router.get('/search', guard(PERM.view), handle((req) => search(pool, ctx(req).companyId, req.query.q)));
router.get('/cockpit', guard(PERM.view), handle((req) => cockpit(pool, ctx(req).companyId)));
export default router;
