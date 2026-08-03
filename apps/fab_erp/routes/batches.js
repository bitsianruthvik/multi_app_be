/**
 * batches.js — running several tasks through one machine together (Issue 4).
 *
 *   GET  /batches/candidates?resourceId=&taskId=   who can join, and why not
 *   POST /batches/preview                          estimate for a selection
 *   POST /batches/start                            start the selection as a batch
 *   GET  /batches/:id                              one batch and its members
 *   POST /batches/:id/complete                     finish, with per-part output
 *
 * Auth mirrors the task lifecycle routes exactly (admin bypass, else
 * fab_erp_taskqueue_view to look and fab_erp_taskqueue_manage to act) — a batch
 * is a task-lifecycle action and shouldn't need its own permission to be
 * granted separately from starting a task on its own.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { recordEvent, recordEvents } from '../services/taskEventService.js';
import { onTaskComplete } from '../services/taskEngineService.js';
import { recomputeTaskAttribution } from '../services/taskAttributionService.js';
import { recomputeForOrder as ccRecomputeForOrder } from '../services/ccBufferService.js';
import * as bufferService from '../services/bufferService.js';
import {
  evaluateCandidates,
  previewBatch,
  startBatch,
  completeBatch,
  BatchError,
} from '../services/batchService.js';

const router = Router();

function requirePerm(req, res, tag) {
  const user = req.user;
  if (user?.role && String(user.role).toLowerCase() === 'admin') return true;
  const granted = Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
  if (!granted) {
    res.status(403).json({ message: `Permission denied. Required: "${tag}".` });
    return false;
  }
  return true;
}

/** Positive integers only, deduped — every id in these routes is a row id. */
function idList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// HTTP status for each way a batch can legitimately be refused. Anything not
// listed is a bug, not a refusal, and falls through to 500.
const ERROR_STATUS = {
  TASK_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  RESOURCE_NOT_FOUND: 404,
  ANCHOR_NOT_FOUND: 404,
  MIXED_OPERATIONS: 400,
  NOT_BATCHABLE: 400,
  BAD_STATUS: 400,
  NO_TASKS: 400,
  NO_RUNNING_TASKS: 400,
  OVER_CAPACITY: 409,
  ALREADY_BATCHED: 409,
  WRONG_MACHINE_TYPE: 409,
  MACHINE_BUSY: 409,
  OUTPUT_BLOCKED: 409,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
};

function sendError(res, err, fallback) {
  const status = ERROR_STATUS[err?.code];
  if (status) {
    return res.status(status).json({ ok: false, code: err.code, message: err.message, blocked: err.blocked });
  }
  logger.error({ err }, fallback);
  return res.status(500).json({ message: 'Internal server error.' });
}

// ── GET /batches/candidates ──────────────────────────────────────────────────

router.get('/batches/candidates', protect, async (req, res) => {
  if (!requirePerm(req, res, 'fab_erp_taskqueue_view')) return;

  const companyId = req.user.companyId;
  const resourceId = Number(req.query.resourceId);
  const taskId = Number(req.query.taskId);
  if (!(resourceId > 0) || !(taskId > 0)) {
    return res.status(400).json({ message: 'resourceId and taskId query params are required.' });
  }

  try {
    const result = await evaluateCandidates(companyId, { resourceId, anchorTaskId: taskId });
    if (result.error) return sendError(res, { code: result.error, message: result.error }, 'batches/candidates');
    return res.json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, 'fab_erp batches/candidates: unexpected error');
  }
});

// ── POST /batches/preview ────────────────────────────────────────────────────

router.post('/batches/preview', protect, async (req, res) => {
  if (!requirePerm(req, res, 'fab_erp_taskqueue_view')) return;

  const companyId = req.user.companyId;
  const resourceId = Number(req.body?.resourceId);
  const taskIds = idList(req.body?.taskIds);
  if (!(resourceId > 0) || !taskIds.length) {
    return res.status(400).json({ message: 'resourceId and a non-empty taskIds array are required.' });
  }

  try {
    const result = await previewBatch(companyId, { resourceId, taskIds });
    if (result.error) return sendError(res, { code: result.error, message: result.error }, 'batches/preview');
    return res.json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, 'fab_erp batches/preview: unexpected error');
  }
});

// ── POST /batches/start ──────────────────────────────────────────────────────

router.post('/batches/start', protect, async (req, res) => {
  if (!requirePerm(req, res, 'fab_erp_taskqueue_manage')) return;

  const user = req.user;
  const companyId = user.companyId;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  const resourceId = Number(req.body?.resourceId);
  const taskIds = idList(req.body?.taskIds);
  const force = req.body?.force === true;

  if (!(resourceId > 0) || taskIds.length < 2) {
    return res.status(400).json({ message: 'resourceId and at least two taskIds are required to batch.' });
  }

  try {
    const result = await startBatch(companyId, {
      resourceId, taskIds, userId: user.id, isAdmin, force,
    });

    // Events post-commit, same as the solo start route (recordEvent uses its
    // own connection).
    await recordEvents(result.started.map((s) => ({
      companyId,
      taskId: s.taskId,
      type: s.priorStatus === 'paused' ? 'resumed' : 'started',
      enteredBy: user.id,
      note: `batch #${result.batchId} (${result.policy.batchMode}) on ${result.policy.resourceName}`,
    })));

    if (result.blocked.length && force && isAdmin) {
      await recordEvents(result.blocked.map((b) => ({
        companyId, taskId: b.taskId, type: 'state_note', source: 'live', enteredBy: user.id,
        note: `force-started in batch #${result.batchId} while output_blocked: ${b.reason}`,
      })));
    }

    // Fire-and-forget refreshes — a recompute failure must never break a start.
    for (const s of result.started) {
      recomputeTaskAttribution(companyId, s.taskId).catch((err) =>
        logger.error({ err, taskId: s.taskId }, 'attribution recompute failed'));
    }
    for (const orderId of [...new Set(result.started.map((s) => s.orderId).filter(Boolean))]) {
      ccRecomputeForOrder(companyId, orderId).catch((err) =>
        logger.error({ err, orderId }, 'cc buffer recompute failed'));
    }

    return res.json({
      ok: true,
      batchId: result.batchId,
      taskIds: result.started.map((s) => s.taskId),
      policy: result.policy,
      estimate: result.estimate,
    });
  } catch (err) {
    if (err?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({ ok: false, code: 'INSUFFICIENT_STOCK', message: err.message });
    }
    return sendError(res, err, 'fab_erp batches/start: unexpected error');
  }
});

// ── GET /batches/:id ─────────────────────────────────────────────────────────

router.get('/batches/:id', protect, async (req, res) => {
  if (!requirePerm(req, res, 'fab_erp_taskqueue_view')) return;

  const companyId = req.user.companyId;
  const batchId = Number(req.params.id);
  if (!(batchId > 0)) return res.status(400).json({ message: 'Batch id must be a positive integer.' });

  try {
    const [batchRows] = await pool.query(
      `SELECT b.id, b.resource_id AS resourceId, b.operation_id AS operationId,
              b.batch_mode AS batchMode, b.status, b.started_at AS startedAt,
              b.completed_at AS completedAt, b.total_minutes AS totalMinutes,
              b.setup_minutes AS setupMinutes,
              r.name AS resourceName, op.name AS operationName
         FROM fab_task_batches b
         LEFT JOIN fab_resources  r  ON r.id  = b.resource_id
         LEFT JOIN fab_operations op ON op.id = b.operation_id
        WHERE b.id = ? AND b.company_id = ? AND b.deleted_at IS NULL LIMIT 1`,
      [batchId, companyId],
    );
    if (!batchRows.length) return res.status(404).json({ message: `Batch #${batchId} not found.` });

    const [members] = await pool.query(
      `SELECT t.id AS taskId, t.status, t.item_id AS itemId, t.order_id AS orderId,
              t.computed_hours AS computedHours, t.attributed_minutes AS attributedMinutes,
              t.produced_qty AS producedQty, t.scrap_qty AS scrapQty, t.qc_result AS qcResult,
              it.name AS itemName, it.mark AS itemMark, it.qty AS itemQty, it.unit AS itemUnit,
              fo.order_number AS orderNumber
         FROM fab_project_tasks t
         LEFT JOIN fab_items  it ON it.id = t.item_id AND it.deleted_at IS NULL
         LEFT JOIN fab_orders fo ON fo.id = t.order_id
        WHERE t.company_id = ? AND t.batch_id = ? AND t.deleted_at IS NULL
        ORDER BY t.id ASC`,
      [companyId, batchId],
    );

    return res.json({ ok: true, batch: batchRows[0], members });
  } catch (err) {
    return sendError(res, err, 'fab_erp batches/:id: unexpected error');
  }
});

// ── POST /batches/:id/complete ───────────────────────────────────────────────

router.post('/batches/:id/complete', protect, async (req, res) => {
  if (!requirePerm(req, res, 'fab_erp_taskqueue_manage')) return;

  const user = req.user;
  const companyId = user.companyId;
  const batchId = Number(req.params.id);
  if (!(batchId > 0)) return res.status(400).json({ message: 'Batch id must be a positive integer.' });

  // { taskId: { producedQty, scrapQty, qcResult } } — members absent from the
  // map pass at planned quantity (see completeBatch).
  const outcomes = req.body?.outcomes && typeof req.body.outcomes === 'object' ? req.body.outcomes : {};
  for (const [k, v] of Object.entries(outcomes)) {
    if (v?.qcResult != null && v.qcResult !== 'pass' && v.qcResult !== 'fail') {
      return res.status(400).json({ message: `qcResult for task ${k} must be 'pass' or 'fail'.` });
    }
    for (const field of ['producedQty', 'scrapQty']) {
      if (v?.[field] != null && v[field] !== '' && !(Number(v[field]) >= 0)) {
        return res.status(400).json({ message: `${field} for task ${k} must be a number ≥ 0.` });
      }
    }
  }

  try {
    const result = await completeBatch(companyId, batchId, {
      outcomes,
      userId: user.id,
      setupMinutesOverride: req.body?.setupMinutes,
    });

    await recordEvents(result.members.map((m) => ({
      companyId, taskId: m.taskId, type: 'completed', enteredBy: user.id,
      note: `batch #${batchId} — ${m.attributedMinutes ?? '?'} min of ${result.totalMinutes} min run`,
    })));

    const reworks = result.members.filter((m) => m.reworkTaskId);
    if (reworks.length) {
      await recordEvents(reworks.flatMap((m) => ([
        {
          companyId, taskId: m.taskId, type: 'state_note', source: 'live', enteredBy: user.id,
          note: `QC fail in batch #${batchId} — rework task ${m.reworkTaskId} created`,
        },
        {
          companyId, taskId: m.reworkTaskId, type: 'state_note', source: 'system',
          note: `rework of task ${m.taskId} (QC fail in batch #${batchId})`,
        },
      ])));
    }

    // Advance the DAG for each member. Sequential, not parallel: onTaskComplete
    // clears successors, and two members of one batch can feed the same
    // downstream task.
    let successorsCleared = 0;
    for (const m of result.members) {
      try {
        const r = await onTaskComplete(companyId, m.taskId);
        successorsCleared += r?.successorsCleared ?? 0;
      } catch (err) {
        logger.error({ err, taskId: m.taskId, batchId }, 'batch onTaskComplete failed');
      }
    }

    for (const m of result.members) {
      recomputeTaskAttribution(companyId, m.taskId).catch((err) =>
        logger.error({ err, taskId: m.taskId }, 'attribution recompute failed'));
      if (m.qcResult === 'pass') {
        bufferService.placeOutput(companyId, { id: m.taskId }).catch((err) =>
          logger.error({ err, taskId: m.taskId }, 'buffer placeOutput failed'));
      }
    }
    for (const orderId of [...new Set(result.members.map((m) => m.orderId).filter(Boolean))]) {
      ccRecomputeForOrder(companyId, orderId).catch((err) =>
        logger.error({ err, orderId }, 'cc buffer recompute failed'));
    }

    // Plan vs actual for the batch as a whole. Per-task variance would be
    // comparing each part against its share of a shared run — true, but the
    // number an operator can act on is whether the RUN beat its estimate.
    const planMinutes = result.members.reduce(
      (a, m) => a + (m.planHours != null ? m.planHours * 60 : 0), 0,
    );

    return res.json({
      ok: true,
      batchId,
      totalMinutes: result.totalMinutes,
      setupMinutes: result.setupMinutes,
      runMinutes: result.runMinutes,
      members: result.members,
      successorsCleared,
      variance: {
        planMinutes: Math.round(planMinutes),
        actualMinutes: Math.round(result.totalMinutes),
        varianceMinutes: Math.round(result.totalMinutes - planMinutes),
      },
    });
  } catch (err) {
    return sendError(res, err, 'fab_erp batches/:id/complete: unexpected error');
  }
});

export default router;
export { BatchError };
