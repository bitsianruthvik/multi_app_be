/**
 * routes/reconciliation.js
 * -------------------------
 * EU-13: Reconciliation feed + unexplained-idle prompt.
 *
 * Everything here is computed ON READ from already-materialized data (Phase 1
 * event/segment tables + EU-6 buffer contents) — there is no nightly job and
 * nothing is cached, so the feed is always fresh at the cost of a handful of
 * set-based queries per request. All queries are company-scoped.
 *
 * Mounted under /api/:companySlug/fab_erp (via routes/index.js).
 *
 * Permission: every endpoint requires the 'fab_erp_machine_state_manage' tag
 * (supervisors), admins bypass — same pattern as routes/machineState.js.
 *
 * Anomalies implemented (see ANOMALY SCOPE below for what's stubbed/skipped):
 *   longRunning     — task in_progress with started_at > 16h ago.
 *   stuckBuffer     — fab_buffer_contents still open (moved_out_at IS NULL)
 *                      with placed_at older than `stuckBufferDays` (default 3).
 *   unexplainedIdle — fab_task_wait_segments row with reason='unexplained_idle'
 *                      and working_minutes > `unexplainedIdleMinutes` (default
 *                      60) on a task that isn't done/cancelled. Primary anomaly.
 *
 * ANOMALY SCOPE (per the EU-13 spec's own guidance to keep #2/#3 minimal):
 *   #2 "machine running with no in_progress task" is SKIPPED — the spec
 *      itself flags it as ambiguous with no clean signal beyond what #1
 *      already covers (a stuck in_progress task), and asks to focus effort on
 *      #1/#4/#5 instead.
 *   #3 "task span fully outside shift hours" is NOT IMPLEMENTED (stubbed per
 *      the spec's own permission to skip it if heavy). Doing this properly
 *      means resolving each task's plant/calendar and walking shift intervals
 *      per task (see taskWaitService.resolveCalendarIds /
 *      workingIntervalsInWindow) — fine for one task at a time, but O(n)
 *      calendar resolution across every in-flight task on every feed poll is
 *      the exact "heavy calendar join" the spec pre-approved stubbing. There
 *      is no findOffShiftSpan() below and the feed never emits this type —
 *      it's a documented gap, not a dead code path.
 *
 * Routes:
 *   GET  /reconciliation/feed    — current anomalies, computed live.
 *   GET  /reconciliation/count   — cheap { ok, count } for a nav badge.
 *   POST /reconciliation/resolve — supervisor resolution. Only `unexplainedIdle`
 *                                   is supported (see the route for why).
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';
import { recordEvent } from '../services/taskEventService.js';

const router = Router();

const REQUIRED_TAG = 'fab_erp_machine_state_manage';

const LONG_RUNNING_HOURS = 16;
const DEFAULT_STUCK_BUFFER_DAYS = 3;
const DEFAULT_UNEXPLAINED_IDLE_MINUTES = 60;

/** Shared authz check — admin bypass, else require the tag in uiPermissions. */
function isAuthorized(user) {
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);
}

function denyPermission(res, user, routeLabel) {
  logger.warn(
    { userId: user?.id, requiredTag: REQUIRED_TAG },
    `fab_erp ${routeLabel}: permission denied`,
  );
  return res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
}

/** Parse a positive-number query param, falling back to `def` when absent/invalid. */
function positiveNumberParam(raw, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// ── anomaly queries (each company-scoped, set-based, no N+1) ───────────────

async function findLongRunning(companyId) {
  const [rows] = await pool.query(
    `SELECT t.id AS taskId, t.started_at AS startedAt, t.assigned_resource_id AS resourceId,
            op.name AS operationName, it.name AS itemName
       FROM fab_project_tasks t
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_items it ON it.id = t.item_id
      WHERE t.company_id = ? AND t.status = 'in_progress' AND t.deleted_at IS NULL
        AND t.started_at IS NOT NULL
        AND t.started_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [companyId, LONG_RUNNING_HOURS],
  );

  return rows.map((r) => {
    const hoursRunning = Math.floor((Date.now() - new Date(r.startedAt).getTime()) / 3600000);
    const what = r.operationName ?? `Operation on task #${r.taskId}`;
    return {
      type: 'longRunning',
      taskId: r.taskId,
      resourceId: r.resourceId,
      label: `${what} has been running ${hoursRunning}h`,
      detail: r.itemName ? `${r.itemName} — started ${r.startedAt}` : `Started ${r.startedAt}`,
      startedAt: r.startedAt,
      operationName: r.operationName,
      itemName: r.itemName,
    };
  });
}

/**
 * WIP that has sat at one machine's stock area too long.
 *
 * Read from fab_stock_pieces since 2026-08-05. It used to read
 * fab_buffer_contents, looking for a row whose moved_out_at was still NULL —
 * but the only thing that ever set moved_out_at was an operator tapping "Move",
 * so this detector largely reported people forgetting to tap rather than
 * material actually sitting. Asking the stock model instead makes it mean what
 * it says: this piece has not moved to another machine since `days` ago.
 *
 * No contentId and no one-tap Move any more — moving a piece is starting its
 * next operation, not a separate gesture. The anomaly names where the metal is
 * and leaves the fix to the queue.
 */
async function findStuckBuffers(companyId, days) {
  const [rows] = await pool.query(
    `SELECT p.id AS pieceId, p.updated_at AS sinceAt, p.qty,
            sl.id AS locationId, sl.code AS locationCode,
            r.id AS resourceId, r.name AS resourceName,
            it.name AS itemName
       FROM fab_stock_pieces p
       JOIN fab_stock_locations sl ON sl.id = p.stock_location_id AND sl.deleted_at IS NULL
       LEFT JOIN fab_resources r ON r.stock_location_id = sl.id AND r.deleted_at IS NULL
       LEFT JOIN fab_items it ON it.id = p.wip_item_id
      WHERE p.company_id = ? AND p.status = 'wip' AND p.deleted_at IS NULL
        AND p.updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [companyId, days],
  );

  return rows.map((r) => {
    const ageDays = Math.floor((Date.now() - new Date(r.sinceAt).getTime()) / 86400000);
    // The resource join can miss when a machine's stock_location_id copy is
    // stale; the location code carries the machine id either way.
    const where = r.resourceName ?? r.locationCode ?? 'a stock area';
    return {
      type: 'stuckBuffer',
      pieceId: r.pieceId,
      resourceId: r.resourceId,
      label: `${r.itemName ?? 'Material'} sitting at ${where} for ${ageDays}d`,
      detail: `Last moved ${r.sinceAt}`,
      placedAt: r.sinceAt,
      ageDays,
    };
  });
}

async function findUnexplainedIdle(companyId, minutes) {
  const [rows] = await pool.query(
    `SELECT s.id AS segmentId, s.task_id AS taskId, s.seg_start AS segStart, s.seg_end AS segEnd,
            s.working_minutes AS workingMinutes, op.name AS operationName, it.name AS itemName
       FROM fab_task_wait_segments s
       JOIN fab_project_tasks t ON t.id = s.task_id AND t.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_items it ON it.id = t.item_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.reason = 'unexplained_idle'
        AND s.working_minutes > ?
        AND t.status NOT IN ('done', 'cancelled')
      ORDER BY s.working_minutes DESC`,
    [companyId, minutes],
  );

  return rows.map((r) => {
    const what = r.operationName ?? `Operation on task #${r.taskId}`;
    return {
      type: 'unexplainedIdle',
      taskId: r.taskId,
      segmentId: r.segmentId,
      minutes: r.workingMinutes,
      label: `${what} — ${r.workingMinutes}m unexplained idle`,
      detail: r.itemName
        ? `${r.itemName} — ${r.segStart} to ${r.segEnd}`
        : `${r.segStart} to ${r.segEnd}`,
    };
  });
}

/** Assemble the full anomaly list — shared by /feed and /count so counts never drift from the feed. */
async function computeAnomalies(companyId, { stuckBufferDays, unexplainedIdleMinutes }) {
  const [longRunning, stuckBuffers, unexplainedIdle] = await Promise.all([
    findLongRunning(companyId),
    findStuckBuffers(companyId, stuckBufferDays),
    findUnexplainedIdle(companyId, unexplainedIdleMinutes),
  ]);
  // unexplainedIdle first — it's the primary anomaly per the spec.
  return [...unexplainedIdle, ...longRunning, ...stuckBuffers];
}

// ── GET /reconciliation/feed ────────────────────────────────────────────────

router.get('/reconciliation/feed', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'reconciliation/feed');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const stuckBufferDays = positiveNumberParam(req.query.stuckBufferDays, DEFAULT_STUCK_BUFFER_DAYS);
  const unexplainedIdleMinutes = positiveNumberParam(
    req.query.unexplainedIdleMinutes,
    DEFAULT_UNEXPLAINED_IDLE_MINUTES,
  );

  try {
    const anomalies = await computeAnomalies(companyId, { stuckBufferDays, unexplainedIdleMinutes });
    return res.status(200).json({ ok: true, anomalies });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp reconciliation/feed: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing reconciliation feed.' });
  }
});

// ── GET /reconciliation/count ───────────────────────────────────────────────
// Cheap badge count — reuses the exact same anomaly computation as /feed (the
// underlying queries are already small/set-based, so a second dedicated
// COUNT(*)-only code path would just be duplicated SQL for no real savings,
// and risks the count drifting from what the feed actually shows).

router.get('/reconciliation/count', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'reconciliation/count');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const stuckBufferDays = positiveNumberParam(req.query.stuckBufferDays, DEFAULT_STUCK_BUFFER_DAYS);
  const unexplainedIdleMinutes = positiveNumberParam(
    req.query.unexplainedIdleMinutes,
    DEFAULT_UNEXPLAINED_IDLE_MINUTES,
  );

  try {
    const anomalies = await computeAnomalies(companyId, { stuckBufferDays, unexplainedIdleMinutes });
    return res.status(200).json({ ok: true, count: anomalies.length });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp reconciliation/count: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing reconciliation count.' });
  }
});

// ── POST /reconciliation/resolve ────────────────────────────────────────────
// Body: { type, taskId, segmentId?, reason, note? }
//
// HONESTY NOTE: this does NOT reclassify the fab_task_wait_segments row. That
// table is materialized/computed exclusively by the attribution engine
// (taskAttributionService) — the schema has no supervisor-override column, so
// there is nothing here to write a new `reason` into even if we wanted to.
// What this DOES do: write a `state_note` fab_task_events row recording the
// supervisor's explanation as an audit trail alongside the segment. The
// segment itself is untouched and will still show as 'unexplained_idle' the
// next time attribution runs or the feed is recomputed — the note is the
// human annotation, not a fix to the computed data. A real reclassify would
// need attribution to support explicit overrides, which is out of scope here.
//
// Only `unexplainedIdle` is supported — longRunning/stuckBuffer resolutions
// go through their own existing endpoints from the frontend (backfill /
// buffer-move), not through this generic resolve route.

router.post('/reconciliation/resolve', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'reconciliation/resolve');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const { type, taskId, segmentId, reason, note } = req.body ?? {};

  if (type !== 'unexplainedIdle') {
    return res.status(400).json({
      message: `Unsupported resolution type "${type}". Only "unexplainedIdle" is supported here.`,
    });
  }

  const taskIdNum = Number(taskId);
  if (!taskId || isNaN(taskIdNum) || taskIdNum <= 0) {
    return res.status(400).json({ message: 'taskId is required and must be a positive integer.' });
  }

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ message: 'reason is required.' });
  }

  const segmentIdNum = segmentId != null ? Number(segmentId) : null;
  if (segmentId != null && (isNaN(segmentIdNum) || segmentIdNum <= 0)) {
    return res.status(400).json({ message: 'segmentId must be a positive integer when provided.' });
  }

  try {
    const [taskRows] = await pool.query(
      `SELECT id FROM fab_project_tasks WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [taskIdNum, companyId],
    );
    if (taskRows.length === 0) {
      return res.status(404).json({ message: `Task with id ${taskIdNum} not found.` });
    }

    const freetext = typeof note === 'string' && note.trim() ? note.trim() : '';
    const composedNote = `reclassify unexplained_idle → ${reason.trim()}${freetext ? `: ${freetext}` : ''}`
      + (segmentIdNum ? ` (segment #${segmentIdNum})` : '');

    const result = await recordEvent({
      companyId,
      taskId: taskIdNum,
      type: 'state_note',
      source: 'live',
      enteredBy: user.id,
      note: composedNote,
    });

    if (!result.ok) {
      return res.status(500).json({ message: 'Failed to record resolution note.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, companyId, taskId: taskIdNum }, 'fab_erp reconciliation/resolve: unexpected error');
    return res.status(500).json({ message: 'Internal server error resolving anomaly.' });
  }
});

export default router;
