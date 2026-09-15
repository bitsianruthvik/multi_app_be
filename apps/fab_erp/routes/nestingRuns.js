/**
 * nestingRuns.js — the blank-plan pack as a background run (PLAN.md EU-11 item 6).
 *
 * `POST /orders/:orderId/blanks/accept` and `GET /orders/:orderId/blanks` (in
 * `orderItems.js`) are UNCHANGED and keep working synchronously for one more
 * release (the plan's own instruction), so this file adds a second way in
 * rather than replacing the first:
 *
 *   POST /orders/:orderId/nesting/runs            { effort } -> { runId }
 *   GET  /orders/:orderId/nesting/runs/:runId      -> { status, progress, result, error }
 *   POST /orders/:orderId/nesting/runs/:runId/cancel
 *   GET  /orders/:orderId/nesting/runs?latest=1    -> the newest DONE run, or null
 *
 * Same `protect` + `requirePerm('fab_erp_projects_manage')` split `orderItems.js`
 * uses for its own blank routes: starting or cancelling a pack is an arranging
 * action, reading one back is a view action.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm, fail } from '../../../core/middleware/requirePerm.js';
import { startRun, getRun, latestDoneRun, cancelRun } from '../services/nestingRunService.js';

const router = Router();

const companyOf = (req) => req.user?.companyId ?? req.user?.company_id;

router.post('/orders/:orderId/nesting/runs', protect, requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const companyId = companyOf(req);
      const orderId = Number(req.params.orderId);
      const effort = req.body?.effort;
      const out = await startRun(companyId, orderId, { effort, requestedBy: req.user?.id ?? null });
      return res.json({ ok: true, ...out });
    } catch (err) {
      return fail(res, err);
    }
  });

// `GET .../runs?latest=1` — a different path shape from `GET .../runs/:runId`
// below (no third segment), so this needs no route-ordering care; it is its
// own route, not a fallback.
router.get('/orders/:orderId/nesting/runs', protect, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const orderId = Number(req.params.orderId);
    if (req.query?.latest === '1') {
      const run = await latestDoneRun(companyId, orderId);
      return res.json({ ok: true, run });
    }
    return res.status(400).json({ message: 'Pass ?latest=1, or GET /nesting/runs/:runId for one run.' });
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/orders/:orderId/nesting/runs/:runId', protect, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const orderId = Number(req.params.orderId);
    const runId = Number(req.params.runId);
    const run = await getRun(companyId, orderId, runId);
    if (!run) return res.status(404).json({ message: 'That nesting run does not exist.' });
    return res.json({ ok: true, ...run });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/orders/:orderId/nesting/runs/:runId/cancel', protect, requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const companyId = companyOf(req);
      const orderId = Number(req.params.orderId);
      const runId = Number(req.params.runId);
      const out = await cancelRun(companyId, orderId, runId);
      return res.json({ ok: true, ...out });
    } catch (err) {
      return fail(res, err);
    }
  });

export default router;
