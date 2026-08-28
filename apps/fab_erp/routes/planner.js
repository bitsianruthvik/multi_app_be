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
  getPlan, getPlanBoard, getBacklog, createEntry, updateEntry, splitEntry, deleteEntry,
  acceptRun, retirePlan, getPlanOrders, savePlanOrderRules, PlanError,
} from '../services/planService.js';
import { withDragSession, endDragSession } from '../services/planDragSession.js';
import { replanFromNow, simulateOrder } from '../services/planReplanService.js';
import { machineLoad } from '../services/planMachineLoadService.js';
import { assignMachines } from '../services/planMachineService.js';
import { transformGroup } from '../services/planGroupService.js';

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
  return res.status(409).json({
    message: err.message,
    code: err.code,
    detail: err.detail,
    // A group move can be refused for several bars at once. The first one is
    // repeated above so every existing client keeps working unchanged.
    ...(Array.isArray(err.refusals) ? { refusals: err.refusals } : {}),
  });
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

/**
 * GET /plan/board — the same plan, in the shape a canvas can paint.
 *
 * Separate from GET /plan because the question is different. The grid asks
 * "what is on this machine today"; the board asks "where are the gaps across the
 * next five weeks", and answering the second one bar-by-bar in the DOM does not
 * work at the size a real order reaches. See getPlanBoard for the payload shape.
 */
router.get('/plan/board', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const win = parseWindow(req.query);
  if (!win) return res.status(400).json({ message: 'from/to are required ISO dates, to > from, at most 92 days apart.' });

  try {
    // `lanesBy=machine` draws a row per machine instead of per resource type —
    // what the day view wants, where "which of the four welders" is the question.
    const board = await getPlanBoard(companyId, {
      ...win,
      resourceTypeIds: parseIdList(req.query.resourceTypeIds),
      lanesBy: req.query.lanesBy === 'machine' ? 'machine' : 'type',
    });
    return res.status(200).json({ ok: true, ...board });
  } catch (err) {
    logger.error({ err, companyId }, 'plan board read failed');
    return res.status(500).json({ message: 'Failed to load the plan board.' });
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

/**
 * GET /plan/orders — the ground rules, before a suggestion is computed.
 *
 * The orders a run over this window would be sequencing, in the sequence it
 * would use, with the two things a planner is allowed to state up front:
 * how much the order matters, and which date is not up for negotiation.
 */
router.get('/plan/orders', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  try {
    const orders = await getPlanOrders(companyId, {
      resourceTypeIds: parseIdList(req.query.resourceTypeIds),
    });
    return res.json({ ok: true, orders });
  } catch (err) {
    logger.error({ err, companyId }, 'plan orders failed');
    return res.status(500).json({ message: 'Failed to load the orders for planning.' });
  }
});

/**
 * POST /plan/orders — save them. Body `{orders:[{orderId, priority, mustFinishBy}]}`
 * IN THE SEQUENCE they should run; `priority_rank` is written from that order.
 */
router.post('/plan/orders', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  try {
    return res.json({ ok: true, ...(await savePlanOrderRules(companyId, req.body?.orders)) });
  } catch (err) {
    if (err instanceof PlanError) {
      return res.status(409).json({ code: err.code, message: err.message, detail: err.detail });
    }
    logger.error({ err, companyId }, 'saving plan order rules failed');
    return res.status(500).json({ message: 'Failed to save the planning rules.' });
  }
});

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

/**
 * POST /plan/retire — take the plan off the board so a fresh one can be accepted.
 *
 * Destructive and deliberately explicit: `orderIds` retires one job's plan and
 * `all: true` is required to clear the whole board, so nothing wipes a plan by
 * omission. Started and pinned bars are never retired and come back in the count.
 */
router.post('/plan/retire', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const orderIds = parseIdList(req.body?.orderIds);
  if (orderIds.length === 0 && req.body?.all !== true) {
    return res.status(400).json({
      message: 'Name the orders to retire, or pass all:true to clear the whole plan.',
    });
  }

  try {
    const result = await retirePlan(companyId, {
      orderIds: orderIds.length > 0 ? orderIds : null,
    }, user.id);
    logger.info({ companyId, ...result }, 'plan retired');
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId }, 'plan retire failed');
    return res.status(500).json({ message: 'Failed to retire the plan.' });
  }
});

/**
 * POST /plan/replan — the world moved; make the plan true again.
 *
 * One action for a changed shift pattern, somebody going on leave, or a morning
 * that simply did not happen. Retires everything not started and not pinned,
 * re-levels the rest from the planning floor, and accepts it. Started work stays
 * exactly where it is and still occupies its machine.
 *
 * Destructive in the same sense as /plan/retire, and deliberately a POST with no
 * arguments needed: there is one obvious thing to mean.
 */
router.post('/plan/replan', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const granularity = ['day', 'week', 'month'].includes(req.body?.granularity)
    ? req.body.granularity
    : 'week';

  try {
    const result = await replanFromNow(companyId, { granularity }, user.id);
    logger.info({ companyId, ...result, skipped: result.skipped.length }, 'plan re-planned from now');
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId }, 'replan failed');
    return res.status(500).json({ message: 'Could not re-plan.' });
  }
});

/**
 * GET /plan/simulate?orderId= — when would this order finish, if we took it?
 *
 * Writes nothing. The order's tasks are levelled against the committed plan held
 * fixed, so the answer accounts for everything already promised rather than
 * describing an empty shop.
 */
router.get('/plan/simulate', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const orderId = Number(req.query.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'orderId is required and must be a positive integer.' });
  }
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity)
    ? req.query.granularity
    : 'week';

  try {
    const result = await simulateOrder(companyId, orderId, { granularity });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    logger.error({ err, companyId, orderId }, 'order simulation failed');
    return res.status(500).json({ message: 'Could not work out a date for that order.' });
  }
});

/**
 * GET /plan/machine-load — what each machine is due to put out, and what is
 * queued in front of it.
 *
 * `?from=&to=&bucket=week|month`. Output is in TONNES, because that is what a
 * fab shop counts and what the order is denominated in; hours come along for
 * whether the machine is full.
 *
 * The same steel is counted at every station it passes, deliberately — a 13 t
 * segment that is cut, welded and painted contributes 13 t to each of those
 * three. Per machine that is right; the SUM across machines is meaningless.
 */
router.get('/plan/machine-load', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const win = parseWindow(req.query);
  if (!win) return res.status(400).json({ message: 'from/to are required ISO dates, to > from, at most 92 days apart.' });

  try {
    const load = await machineLoad(companyId, {
      ...win,
      bucket: req.query.bucket === 'month' ? 'month' : 'week',
    });
    return res.status(200).json({ ok: true, ...load });
  } catch (err) {
    logger.error({ err, companyId }, 'machine load read failed');
    return res.status(500).json({ message: 'Failed to read machine load.' });
  }
});

/**
 * POST /plan/assign — put a task on a particular machine, or re-balance a type.
 *
 * With `taskEntryIds` and `resourceId` it is the planner overriding one
 * placement; with neither it re-runs the assignment for the named types, which
 * is what to do after work has been dragged about.
 */
router.post('/plan/assign', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const result = await assignMachines(companyId, {
      resourceTypeIds: parseIdList(req.body?.resourceTypeIds),
      reassign: req.body?.reassign === true,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err, companyId }, 'machine assignment failed');
    return res.status(500).json({ message: 'Could not assign machines.' });
  }
});

// ─── editing ──────────────────────────────────────────────────────────────────

/**
 * POST /plan/group — move, stretch, push left, or restore a whole unit.
 *
 * Not PATCH /plan/entries/:id in a loop. Every intermediate state of a group
 * move is illegal, so bar-at-a-time is refused on the first call for a
 * violation the finished move would not have had. This validates the FINAL
 * state and writes it in one transaction: all of it lands, or none does.
 *
 * `dryRun` returns the same answer without writing, which is what the board
 * calls while a handle is still being dragged.
 */
router.post('/plan/group', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  /**
   * All the requests of one drag share their reads.
   *
   * The board mints `sessionId` when the handle goes down and sends it with
   * every validity check and the commit. While a planner holds a unit, the rest
   * of the plan is frozen by definition, so asking the database the same three
   * dozen questions on each of those requests only bought latency. Without a
   * sessionId this behaves exactly as it did. See planDragSession.
   */
  const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.length > 0
    ? req.body.sessionId
    : null;

  try {
    const { result: out, reused } = await withDragSession(
      companyId, user?.id ?? null, sessionId,
      () => transformGroup(companyId, req.body ?? {}, user?.id ?? null),
    );
    // A drag that wrote has invalidated its own cache: every answer in it
    // describes the plan as it was before this call.
    if (out.applied) endDragSession(companyId, user?.id ?? null, sessionId);
    if (sessionId) logger.debug({ companyId, sessionId, reused }, 'plan group drag session');
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof PlanError) return sendPlanError(res, err);
    // Not a refusal but a fault: drop the session rather than let a gesture
    // keep reasoning from reads that may have been half-collected.
    endDragSession(companyId, user?.id ?? null, sessionId);
    logger.error({ err, companyId }, 'plan group transform failed');
    return res.status(500).json({ message: 'Could not move that unit.' });
  }
});

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
