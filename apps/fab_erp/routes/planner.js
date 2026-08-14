/**
 * routes/planner.js — the Production Planner.
 *
 * Mounted separately in app.js alongside routes/criticalChain.js rather than
 * folded into routes/index.js, matching that precedent. It replaced
 * routes/dispatch.js, which was deleted with this change.
 *
 * Suggesting and accepting are deliberately two calls, for the same reason
 * dispatch split preview from confirm: every input to the ranking moves within
 * minutes, so what a planner approves has to be a specific frozen list rather
 * than "whatever the engine says at the moment they clicked".
 *
 * GET /plan/suggest WRITES — it persists the run it computed. That is
 * deliberate and is why it is not a POST: it is idempotent from the caller's
 * point of view (nothing about the plan changes) but the ideal has to be frozen
 * at the instant it was produced or the retrospective compares against a
 * hindsight-perfect reconstruction of itself.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { suggestPlan } from '../services/planSuggestionService.js';
import {
  getPlan, getBacklog, createEntry, updateEntry, splitEntry, deleteEntry,
  acceptRun, PlanError,
} from '../services/planService.js';

const router = Router();

const VIEW_TAG = 'fab_erp_planner_view';
const MANAGE_TAG = 'fab_erp_planner_manage';

function isAuthorized(user, tag) {
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
}

function denyPermission(res, tag) {
  return res.status(403).json({ message: `Permission denied. Required: "${tag}".` });
}

/** A PlanError is a refusal the planner can act on, not a server fault. */
function sendPlanError(res, err) {
  return res.status(409).json({ message: err.message, code: err.code, detail: err.detail });
}

function parseIdList(raw) {
  if (raw == null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))];
}

/**
 * Window parsing. Both ends are required rather than defaulted: a planner asking
 * for "the plan" without saying when means the client has a bug, and inventing a
 * window would hide it behind a screen of plausible bars.
 */
function parseWindow(q) {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (!(to > from)) return null;
  // 92 days is a quarter. Past that the coverage sweep does a capacityIntervals
  // call per machine per window and the response stops being a page.
  if (to.getTime() - from.getTime() > 92 * 86400000) return null;
  return { from, to };
}

// ─── reading ──────────────────────────────────────────────────────────────────

router.get('/plan', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const win = parseWindow(req.query);
  if (!win) return res.status(400).json({ message: 'from/to are required ISO dates, to > from, at most 92 days apart.' });

  try {
    const plan = await getPlan(companyId, { ...win, resourceTypeIds: parseIdList(req.query.resourceTypeIds) });
    return res.status(200).json({ ok: true, ...plan });
  } catch (err) {
    logger.error({ err, companyId }, 'plan read failed');
    return res.status(500).json({ message: 'Failed to load the plan.' });
  }
});

router.get('/plan/backlog', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 200;

  try {
    const tasks = await getBacklog(companyId, {
      resourceTypeIds: parseIdList(req.query.resourceTypeIds), limit,
    });
    return res.status(200).json({ ok: true, tasks });
  } catch (err) {
    logger.error({ err, companyId }, 'plan backlog failed');
    return res.status(500).json({ message: 'Failed to load unplanned work.' });
  }
});

// ─── suggesting ───────────────────────────────────────────────────────────────

router.get('/plan/suggest', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const win = parseWindow(req.query);
  if (!win) return res.status(400).json({ message: 'from/to are required ISO dates, to > from, at most 92 days apart.' });

  try {
    const run = await suggestPlan(companyId, {
      ...win,
      resourceTypeIds: parseIdList(req.query.resourceTypeIds),
      bundling: req.query.bundling !== 'false',
      userId: user.id,
    });
    return res.status(200).json({ ok: true, ...run });
  } catch (err) {
    logger.error({ err, companyId }, 'plan suggest failed');
    return res.status(500).json({ message: 'Failed to compute a suggestion.' });
  }
});

router.post('/plan/accept', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const runId = Number(req.body?.runId);
  if (!Number.isFinite(runId) || runId <= 0) {
    return res.status(400).json({ message: 'runId is required and must be a positive integer.' });
  }

  try {
    const result = await acceptRun(companyId, runId, {
      runItemIds: parseIdList(req.body?.runItemIds),
      pin: !!req.body?.pin,
    }, user.id);
    logger.info({ companyId, runId, ...result }, 'plan run accepted');
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId, runId }, 'plan accept failed');
    return res.status(500).json({ message: 'Failed to accept the suggestion.' });
  }
});

// ─── editing ──────────────────────────────────────────────────────────────────

router.post('/plan/entries', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const taskIds = parseIdList(req.body?.taskIds);
  if (taskIds.length === 0) return res.status(400).json({ message: 'taskIds is required.' });
  if (!req.body?.plannedStart) return res.status(400).json({ message: 'plannedStart is required.' });

  try {
    const result = await createEntry(companyId, { ...req.body, taskIds }, user.id);
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId }, 'plan entry create failed');
    return res.status(500).json({ message: 'Failed to add to the plan.' });
  }
});

router.patch('/plan/entries/:id', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const entryId = Number(req.params.id);
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return res.status(400).json({ message: 'Entry id must be a positive integer.' });
  }

  try {
    const result = await updateEntry(companyId, entryId, req.body ?? {}, user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId, entryId }, 'plan entry update failed');
    return res.status(500).json({ message: 'Failed to update the plan entry.' });
  }
});

router.post('/plan/entries/:id/split', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const entryId = Number(req.params.id);
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return res.status(400).json({ message: 'Entry id must be a positive integer.' });
  }

  try {
    const result = await splitEntry(companyId, entryId, {
      taskIds: parseIdList(req.body?.taskIds),
    }, user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId, entryId }, 'plan entry split failed');
    return res.status(500).json({ message: 'Failed to split the plan entry.' });
  }
});

router.delete('/plan/entries/:id', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const entryId = Number(req.params.id);
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return res.status(400).json({ message: 'Entry id must be a positive integer.' });
  }

  try {
    const result = await deleteEntry(companyId, entryId, user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err, companyId, entryId }, 'plan entry delete failed');
    return res.status(500).json({ message: 'Failed to remove the plan entry.' });
  }
});

export default router;
