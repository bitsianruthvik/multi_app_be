/**
 * routes/tasks.js
 * ---------------
 * EU-9: Task queue summary and management routes for fab_erp.
 * EU-5: Task instantiation route (POST /tasks/materialize) added below.
 * EU-8: Task lifecycle routes (POST /tasks/:id/start|pause|stop) added below.
 *
 * Mounted under /api/:companySlug/fab_erp
 *
 * Routes:
 *   GET /tasks/queue-summary?resourceId=N
 *     Returns task counts (eligible, in_progress, paused) and full task list
 *     for one fab_resources row, including unassigned tasks of matching type.
 *
 *   POST /tasks/materialize
 *     Body: { orderId }
 *     Auth: JWT required (protect middleware).
 *     Authz: req.user.role === 'admin'  OR
 *            req.user.uiPermissions includes 'fab_erp_taskqueue_manage'
 *     Calls: materializeTasks(companyId, orderId)
 *     Returns:
 *       200  { ok: true, itemsProcessed, itemsSkipped, tasksInserted }
 *       400  { message: '...' }   — validation error
 *       403  { message: '...' }   — permission denied
 *       500  { message: '...' }   — unexpected errors
 *
 * NOTE (EU-5): this file's pre-existing GET /tasks/queue-summary route
 * imported `getPool` from '../../../core/db/pool.js', a module that does not
 * exist anywhere in this repo (verified via search) — the route was dead code,
 * never mounted in routes/index.js, and would have crashed the app on startup
 * the moment this router was mounted. Fixed minimally by switching to the
 * `pool` export from '../../../db.js', the convention used by every other
 * fab_erp service (see grnService.js), so mounting this router does not break
 * the server. No other logic in that route was touched.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';
import { recordEvent, recordEvents, supersedeEvent } from '../services/taskEventService.js';
import { materializeTasks } from '../services/taskInstanceService.js';
import { previewRematerialize, applyRematerialize } from '../services/rematerializeService.js';
import { portfolioProgress, computeStageBreakdown } from '../services/progressReportService.js';
import { computeActualHoursForTasks, computeTaskVariance } from '../services/taskVarianceService.js';
import {
  computeTaskWaitMetrics,
  resolveTaskCalendarIds,
  workingIntervalsInWindow,
  fetchOverlappingOtherTasks,
} from '../services/taskWaitService.js';
import { onTaskComplete, rollUpOrderStatus, spawnReworkTask } from '../services/taskEngineService.js';
import { openOrMoveWipOnStart, finalizeWipOnComplete } from '../services/wipInventoryService.js';
import { recomputeTaskAttribution, recomputeForResource } from '../services/taskAttributionService.js';
import {
  workersBlockedElsewhere, attachWorkersToTask, detachWorkersFromTask,
} from '../services/workerService.js';
import * as bufferService from '../services/bufferService.js';
import { isOutputBlocked, startBlockersForQueue } from '../services/taskGatingService.js';
import { recomputeForOrder as ccRecomputeForOrder } from '../services/ccBufferService.js';
import { taskHours } from '../services/taskDuration.js';

const router = Router();

// ── EU-10 helpers ─────────────────────────────────────────────────────────────

/**
 * Format a JS Date as a MySQL DATETIME literal in UTC wall-clock
 * ('YYYY-MM-DD HH:MM:SS'). The wait/calendar math in taskWaitService works in
 * UTC, so storing the same UTC instant keeps backfilled rows consistent with the
 * shift-membership warnings computed against them.
 */
function toSqlUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * True when `tsDate` does NOT fall inside any working shift interval of the given
 * calendars. Probes a ±1 min window around the instant and tests membership.
 * Callers must guard on calendarIds.length > 0 (no calendars = cannot judge).
 */
async function timestampOutsideShift(companyId, calendarIds, tsDate) {
  const windowStart = new Date(tsDate.getTime() - 60000);
  const windowEnd = new Date(tsDate.getTime() + 60000);
  const intervals = await workingIntervalsInWindow(companyId, calendarIds, windowStart, windowEnd);
  const t = tsDate.getTime();
  return !intervals.some((iv) => iv.start.getTime() <= t && t <= iv.end.getTime());
}

// ── GET /tasks/queue-summary ────────────────────────────────────────────────

router.get('/tasks/queue-summary', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_view';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/queue-summary: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { resourceId } = req.query;
  const rid = Number(resourceId);

  if (!resourceId || isNaN(rid) || rid <= 0) {
    return res.status(400).json({ message: 'resourceId query param is required and must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    // Get the resource's resource_type_id so we can match unassigned tasks
    const resourceQuery = `
      SELECT resource_type_id
      FROM fab_resources
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL
      LIMIT 1
    `;

    const [resourceRows] = await pool.query(resourceQuery, [rid, companyId]);

    if (!resourceRows || resourceRows.length === 0) {
      return res.status(404).json({ message: `Resource with id ${rid} not found.` });
    }

    const resourceTypeId = resourceRows[0].resource_type_id;

    // Main task query: get all tasks (eligible, in_progress, paused) that match
    // this resource, including unassigned tasks of the same resource type.
    const tasksQuery = `
      SELECT
        t.id,
        t.operation_id AS operationId,
        op.name AS operationName,
        t.order_id AS orderId,
        fo.order_number AS orderNumber,
        t.item_id AS itemId,
        it.name AS itemName,
        it.mark AS itemMark,
        it.qty AS itemQty,
        it.unit AS itemUnit,
        ic.code AS itemCode,
        t.seq_no AS seqNo,
        t.status,
        t.deps_cleared_at AS depsClearedAt,
        t.wait_working_minutes AS waitWorkingMinutes,
        t.blocked_by_other_tasks_minutes AS blockedByOtherTasksMinutes,
        t.idle_wait_minutes AS idleWaitMinutes,
        t.delay_reason AS delayReason,
        t.computed_hours AS computedHours, t.setup_hours AS setupHours, t.task_qty AS taskQty,
        t.assigned_resource_id AS assignedResourceId,
        t.queued_at AS queuedAt,
        t.started_at AS startedAt,
        t.paused_at AS pausedAt,
        t.completed_at AS completedAt,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt
      FROM fab_project_tasks t
      LEFT JOIN fab_operations op ON t.operation_id = op.id
      LEFT JOIN fab_orders fo ON t.order_id = fo.id
      LEFT JOIN fab_items it ON it.id = t.item_id AND it.deleted_at IS NULL
      LEFT JOIN fab_item_catalog ic ON ic.id = it.catalog_item_id AND ic.deleted_at IS NULL
      WHERE t.company_id = ?
        AND t.status IN ('eligible', 'in_progress', 'paused')
        AND t.deleted_at IS NULL
        AND (
          t.assigned_resource_id = ?
          OR (t.assigned_resource_id IS NULL AND t.resource_type_id = ?)
        )
      ORDER BY t.seq_no ASC, t.id ASC
    `;

    const [taskRows] = await pool.query(tasksQuery, [companyId, rid, resourceTypeId]);

    // ── Where does this work sit in the project? ────────────────────────────
    //
    // The queue previously returned item_id and nothing else, so an operator saw
    // "Cut Plate (CNC) · SO-0001" and had no way to know *which part* to pick up
    // — the single most important fact on the screen was missing.
    //
    // Resolve each distinct item to its ancestor chain in one recursive pass
    // rather than per row: a queue is dozens of tasks over a handful of items,
    // so per-row walking would be mostly duplicate work.
    const itemIds = [...new Set(taskRows.map((t) => t.itemId).filter(Boolean))];
    const pathByItem = new Map();

    if (itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',');
      const [pathRows] = await pool.query(
        `WITH RECURSIVE chain AS (
           SELECT id AS leaf_id, id, parent_item_id, name, 0 AS depth
           FROM fab_items
           WHERE id IN (${placeholders}) AND company_id = ? AND deleted_at IS NULL
           UNION ALL
           SELECT c.leaf_id, p.id, p.parent_item_id, p.name, c.depth + 1
           FROM chain c
           JOIN fab_items p ON p.id = c.parent_item_id AND p.deleted_at IS NULL
           WHERE c.depth < 20            -- cycle guard; BOM trees are shallow
         )
         SELECT leaf_id, id, name, depth FROM chain ORDER BY leaf_id, depth DESC`,
        [...itemIds, companyId],
      );

      for (const r of pathRows) {
        if (!pathByItem.has(r.leaf_id)) pathByItem.set(r.leaf_id, []);
        // depth DESC => root first, leaf last: "Bridge Span 1 › Girder A › Web Plate"
        pathByItem.get(r.leaf_id).push(r.name);
      }
    }

    for (const t of taskRows) {
      const path = pathByItem.get(t.itemId) ?? [];
      // itemName is the leaf; itemPath is the ancestors above it, so the UI can
      // lead with the part and show its context underneath. Falls back to the
      // row's own joined name when the recursive walk found nothing.
      t.itemName = path.length ? path[path.length - 1] : (t.itemName ?? null);
      t.itemPath = path.slice(0, -1);
    }

    // ── What would refuse to start? ─────────────────────────────────────────
    //
    // Until now this endpoint filtered on status alone, so it listed work that
    // 409s the moment an operator presses Start — the buffer and material gates
    // were only evaluated inside POST /tasks/:id/start. Answering it here costs
    // a couple of queries and turns a red toast into something visible in
    // advance. Best-effort: if the check itself fails the queue still renders,
    // because a queue that shows work optimistically is far better than none.
    let blockers = new Map();
    try {
      blockers = await startBlockersForQueue(companyId, rid, taskRows);
    } catch (blockErr) {
      logger.warn({ err: blockErr, companyId, resourceId: rid }, 'queue-summary: start-blocker check failed');
    }
    for (const t of taskRows) {
      const b = blockers.get(t.id);
      t.startBlocked = !!b;
      t.blockKind = b ? (b.outputBlocked ? 'output_blocked' : 'material_short') : null;
      t.blockReason = b?.reason ?? null;
    }

    // Count tasks by status
    const counts = {
      eligible: taskRows.filter(t => t.status === 'eligible').length,
      in_progress: taskRows.filter(t => t.status === 'in_progress').length,
      paused: taskRows.filter(t => t.status === 'paused').length,
      // Eligible on paper but would refuse right now — the number that explains
      // why the queue looks longer than the work an operator can actually pick up.
      blocked: taskRows.filter(t => (t.status === 'eligible' || t.status === 'paused') && t.startBlocked).length,
    };

    return res.status(200).json({
      ok: true,
      counts,
      tasks: taskRows,
    });
  } catch (err) {
    logger.error({ err, companyId, resourceId }, 'fab_erp tasks/queue-summary: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching task queue summary.' });
  }
});

// ── POST /tasks/materialize ─────────────────────────────────────────────────

router.post('/tasks/materialize', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/materialize: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { orderId } = req.body ?? {};

  if (orderId === undefined || orderId === null || isNaN(Number(orderId))) {
    return res.status(400).json({ message: 'orderId is required and must be a number.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Call service ───────────────────────────────────────────────────────────
  try {
    const result = await materializeTasks(companyId, Number(orderId));

    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp tasks/materialize: unexpected error');
    return res.status(500).json({ message: 'Internal server error during task materialization.' });
  }
});

// ── POST /tasks/rematerialize/preview ───────────────────────────────────────
// FEAT-07: read-only diff of what re-generating the order's DAG from the current
// flow definitions would change (added / removed / changed / retained-started).
router.post('/tasks/rematerialize/preview', protect, async (req, res) => {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    if (!(Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG))) {
      return res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
    }
  }
  const { orderId } = req.body ?? {};
  if (orderId === undefined || orderId === null || isNaN(Number(orderId))) {
    return res.status(400).json({ message: 'orderId is required and must be a number.' });
  }
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const result = await previewRematerialize(companyId, Number(orderId));
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp tasks/rematerialize/preview: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing re-materialization preview.' });
  }
});

// ── POST /tasks/rematerialize ───────────────────────────────────────────────
// FEAT-07: apply the re-generation — drop unstarted work, rebuild from the
// current flows, and preserve every started/done task.
router.post('/tasks/rematerialize', protect, async (req, res) => {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    if (!(Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG))) {
      return res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
    }
  }
  const { orderId } = req.body ?? {};
  if (orderId === undefined || orderId === null || isNaN(Number(orderId))) {
    return res.status(400).json({ message: 'orderId is required and must be a number.' });
  }
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const result = await applyRematerialize(companyId, Number(orderId));
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp tasks/rematerialize: unexpected error');
    return res.status(500).json({ message: 'Internal server error during re-materialization.' });
  }
});

// ── GET /tasks/progress ─────────────────────────────────────────────────────
// Project Progress view (2026-07-24). No orderId → portfolio (active orders +
// overall % + resolved template). With orderId (+ optional itemId/scope) → the
// per-stage breakdown for that scope. Gated fab_erp_taskengine_view.
router.get('/tasks/progress', protect, async (req, res) => {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskengine_view';
    if (!(Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG))) {
      return res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
    }
  }
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const { orderId } = req.query;
    if (orderId === undefined) {
      const result = await portfolioProgress(companyId);
      return res.status(200).json(result);
    }
    const oid = Number(orderId);
    if (isNaN(oid) || oid <= 0) {
      return res.status(400).json({ message: 'orderId must be a positive integer.' });
    }
    const result = await computeStageBreakdown(companyId, oid, {
      itemId: req.query.itemId,
      scope: req.query.scope === 'self' ? 'self' : 'subtree',
    });
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp tasks/progress: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing progress.' });
  }
});

// ── GET /tasks/graph ────────────────────────────────────────────────────────
// EU-11: order-wide task DAG (all fab_items instances of an order in one
// response — one DAG per order, not per item, per design).
//
// depends_on/edge-derivation logic below is a direct copy of
// taskEngineService.js's parseDependsOn() + previousSeqNo() (see that file's
// header comment for the scoping rationale: depends_on stores seq_no values
// that are only unique WITHIN one (item_id, flow_id) instance, since
// materializeTasks() gives every fab_items instance its own full copy of a
// flow's steps as separate fab_project_tasks rows — so edges must be resolved
// per (item_id, flow_id) group, never across groups, or sibling instances
// running the same flow would get bogus cross-edges).

function parseDependsOnCsv(csv) {
  if (csv === null || csv === undefined) return [];
  const str = String(csv).trim();
  if (str === '') return [];
  return str
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
}

router.get('/tasks/graph', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_projectdag_view';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/graph: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { orderId } = req.query;
  const oid = Number(orderId);

  if (!orderId || isNaN(oid) || oid <= 0) {
    return res.status(400).json({ message: 'orderId query param is required and must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    // EU-1: optional itemId/scope narrowing. If itemId is absent or invalid,
    // itemScopeIds stays null and the whole-order behavior is unchanged.
    let itemScopeIds = null;
    const itemIdRaw = req.query.itemId;

    if (itemIdRaw !== undefined) {
      const iid = Number(itemIdRaw);

      if (Number.isInteger(iid) && iid > 0) {
        const scope = req.query.scope === 'self' ? 'self' : 'subtree';

        if (scope === 'self') {
          itemScopeIds = [iid];
        } else {
          const [treeRows] = await pool.query(
            `WITH RECURSIVE item_tree AS (
               SELECT id, parent_item_id, 0 AS depth
                 FROM fab_items
                WHERE id = ? AND company_id = ? AND order_id = ? AND deleted_at IS NULL
               UNION ALL
               SELECT fi.id, fi.parent_item_id, item_tree.depth + 1
                 FROM fab_items fi
                 JOIN item_tree ON fi.parent_item_id = item_tree.id
                WHERE item_tree.depth < 12 AND fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
             )
             SELECT id FROM item_tree`,
            [iid, companyId, oid, companyId, oid],
          );
          itemScopeIds = treeRows.map((r) => r.id);
        }
      }
    }

    if (itemScopeIds !== null && itemScopeIds.length === 0) {
      return res.status(200).json({ ok: true, nodes: [], edges: [] });
    }

    let taskSql = `SELECT
         t.id,
         t.operation_id AS operationId,
         op.name AS operationName,
         t.item_id AS itemId,
         it.name AS itemName,
         it.mark AS itemMark,
         it.parent_item_id AS parentItemId,
         t.flow_id AS flowId,
         t.seq_no AS seqNo,
         t.depends_on AS dependsOn,
         t.status,
         t.resource_type_id AS resourceTypeId,
         rt.name AS resourceTypeName,
         t.assigned_resource_id AS assignedResourceId,
         t.deps_cleared_at AS depsClearedAt,
         t.wait_working_minutes AS waitWorkingMinutes,
         t.blocked_by_other_tasks_minutes AS blockedByOtherTasksMinutes,
         t.idle_wait_minutes AS idleWaitMinutes,
         t.delay_reason AS delayReason,
         t.started_at AS startedAt,
         t.paused_at AS pausedAt,
         t.completed_at AS completedAt,
         t.computed_hours AS computedHours
       FROM fab_project_tasks t
       LEFT JOIN fab_operations op ON t.operation_id = op.id
       LEFT JOIN fab_items it ON t.item_id = it.id
       LEFT JOIN fab_resource_types rt ON t.resource_type_id = rt.id
       WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL AND t.status <> 'cancelled'`;
    const taskParams = [companyId, oid];

    if (itemScopeIds !== null) {
      taskSql += ` AND t.item_id IN (?)`;
      taskParams.push(itemScopeIds);
    }

    taskSql += ` ORDER BY t.item_id ASC, t.flow_id ASC, t.seq_no ASC, t.id ASC`;

    const [taskRows] = await pool.query(taskSql, taskParams);

    if (taskRows.length === 0) {
      return res.status(200).json({ ok: true, nodes: [], edges: [] });
    }

    // Group rows by (item_id, flow_id) — every edge must be derived within one
    // group only (see file-header comment above / taskEngineService.js).
    const groups = new Map();
    for (const row of taskRows) {
      const key = `${row.itemId}:${row.flowId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const edges = [];
    for (const rows of groups.values()) {
      const seqNos = rows.map((r) => r.seqNo).sort((a, b) => a - b);
      const taskIdBySeqNo = new Map(rows.map((r) => [r.seqNo, r.id]));

      // previous seq_no in this (item_id, flow_id) instance — mirrors
      // taskEngineService.js::previousSeqNo()
      function previousSeqNo(seqNo) {
        let prev = null;
        for (const s of seqNos) {
          if (s < seqNo && (prev === null || s > prev)) prev = s;
        }
        return prev;
      }

      for (const row of rows) {
        const deps = parseDependsOnCsv(row.dependsOn);
        const predecessorSeqNos = deps.length > 0 ? deps : (() => {
          const prev = previousSeqNo(row.seqNo);
          return prev === null ? [] : [prev];
        })();

        for (const sn of predecessorSeqNos) {
          const fromId = taskIdBySeqNo.get(sn);
          if (fromId != null) edges.push({ from: fromId, to: row.id, kind: 'flow' });
        }
      }
    }

    // EU-1: cross-item (cross-BOM) component edges, derived from
    // fab_task_inputs gated component links. An edge is drawn from the
    // producing item's terminal task (max seq_no across ALL of that item's
    // tasks, tie-break by max id — mirrors taskGatingService.terminalTaskDone)
    // to the consuming task, regardless of the terminal task's status.
    const taskIdSet = new Set(taskRows.map((r) => r.id));
    const terminalTaskByItem = new Map();
    for (const row of taskRows) {
      const current = terminalTaskByItem.get(row.itemId);
      if (!current || row.seqNo > current.seqNo || (row.seqNo === current.seqNo && row.id > current.id)) {
        terminalTaskByItem.set(row.itemId, { id: row.id, seqNo: row.seqNo });
      }
    }

    const [inputRows] = await pool.query(
      `SELECT task_id AS taskId, producing_item_id AS producingItemId
         FROM fab_task_inputs
        WHERE company_id = ? AND order_id = ? AND input_role = 'component'
          AND gate = 1 AND producing_item_id IS NOT NULL AND deleted_at IS NULL`,
      [companyId, oid],
    );

    const seenComponentEdges = new Set();
    for (const row of inputRows) {
      if (!taskIdSet.has(row.taskId)) continue;
      const terminal = terminalTaskByItem.get(row.producingItemId);
      if (!terminal) continue;

      const edgeKey = `${terminal.id}:${row.taskId}:component`;
      if (seenComponentEdges.has(edgeKey)) continue;
      seenComponentEdges.add(edgeKey);

      edges.push({ from: terminal.id, to: row.taskId, kind: 'component' });
    }

    // FEAT-16: batch-compute actual touch hours for the done tasks, so each node
    // can show plan vs actual variance (one event query for the whole order).
    const doneIds = taskRows.filter((r) => r.status === 'done').map((r) => r.id);
    const actualsMap = await computeActualHoursForTasks(pool, companyId, doneIds);
    const varianceOf = (r) => {
      const a = actualsMap.get(r.id);
      if (r.computedHours == null || a == null) return null;
      return Math.round((a - Number(r.computedHours)) * 100) / 100;
    };

    const nodes = taskRows.map((r) => ({
      id: r.id,
      operationId: r.operationId,
      operationName: r.operationName,
      itemId: r.itemId,
      itemName: r.itemName,
      parentItemId: r.parentItemId,
      flowId: r.flowId,
      seqNo: r.seqNo,
      status: r.status,
      dependsOn: r.dependsOn,
      resourceTypeId: r.resourceTypeId,
      resourceTypeName: r.resourceTypeName,
      assignedResourceId: r.assignedResourceId,
      depsClearedAt: r.depsClearedAt,
      waitWorkingMinutes: r.waitWorkingMinutes,
      blockedByOtherTasksMinutes: r.blockedByOtherTasksMinutes,
      idleWaitMinutes: r.idleWaitMinutes,
      delayReason: r.delayReason,
      startedAt: r.startedAt,
      pausedAt: r.pausedAt,
      completedAt: r.completedAt,
      computedHours: r.computedHours,
      actualHours: actualsMap.get(r.id) ?? null,
      varianceHours: varianceOf(r),
    }));

    return res.status(200).json({ ok: true, nodes, edges });
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp tasks/graph: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching project task graph.' });
  }
});

// ── GET /tasks/overview ─────────────────────────────────────────────────────
// EU-2: per-order task-status rollup across the company. Only "active"
// orders are returned — i.e. orders whose tasks aren't all done yet — sorted
// by remaining (not-done) task count descending.

router.get('/tasks/overview', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskengine_view';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/overview: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    const [rows] = await pool.query(
      `SELECT t.order_id AS orderId, fo.order_number AS orderNumber,
              COUNT(*) AS total,
              SUM(t.status = 'done') AS done,
              SUM(t.status = 'in_progress') AS in_progress,
              SUM(t.status IN ('blocked', 'eligible')) AS not_started,
              SUM(t.status = 'paused') AS paused
         FROM fab_project_tasks t
         JOIN fab_orders fo ON fo.id = t.order_id AND fo.company_id = t.company_id
        WHERE t.company_id = ? AND t.deleted_at IS NULL AND t.status <> 'cancelled'
        GROUP BY t.order_id, fo.order_number`,
      [companyId],
    );

    const orders = rows
      .map((r) => ({
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        counts: {
          total: Number(r.total),
          done: Number(r.done),
          in_progress: Number(r.in_progress),
          not_started: Number(r.not_started),
          paused: Number(r.paused),
        },
      }))
      .filter((o) => o.counts.done < o.counts.total)
      .sort((a, b) => (b.counts.total - b.counts.done) - (a.counts.total - a.counts.done));

    return res.status(200).json({ ok: true, orders });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp tasks/overview: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching task overview.' });
  }
});

// ── POST /tasks/:id/start ───────────────────────────────────────────────────
// EU-8: Task lifecycle — start.
//
// Legal from status 'eligible' (first start) or 'paused' (resume).
//
// Calls taskWaitService's computeTaskWaitMetrics(task, now) to compute
// wait_working_minutes / blocked_by_other_tasks_minutes / idle_wait_minutes
// as of now, then persists those three fields alongside started_at = UTC_TIMESTAMP()
// and status = 'in_progress'.
//
// EU-2: also dual-writes a fab_task_events row — 'started' from 'eligible',
// 'resumed' from 'paused'.

router.post('/tasks/:id/start', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/start: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const taskId = Number(req.params.id);

  if (!req.params.id || isNaN(taskId) || taskId <= 0) {
    return res.status(400).json({ message: 'Task id must be a positive integer.' });
  }

  // EU-2: delay_reason is no longer required/validated/persisted — accepted-and-ignored if present.
  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // BUG-09: the machine to run on. Prefer the machine sent from the queue
  // (the operator picked it); fall back to any prior assignment (resume).
  const requestedResourceId = Number(req.body?.resourceId) > 0 ? Number(req.body.resourceId) : null;
  // EU-8 admins may force past the output-blocked guard with body {force:true}.
  const forced = req.body?.force === true;

  // Who is doing the work. Optional: omitting it keeps the pre-2026-08-06
  // behaviour exactly. When supplied, these people are recorded against the task
  // (the traceability record — which welder made which joint) and the busy rule
  // below applies to them.
  const workerIds = Array.isArray(req.body?.workerIds)
    ? [...new Set(req.body.workerIds.map(Number).filter((n) => n > 0))]
    : [];
  // Explicit confirmation of "yes, move them off the machine they're on".
  const moveWorkers = req.body?.moveWorkers === true;
  const movedWorkers = [];

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    // The core invariant (status guard + no machine double-booking) is enforced
    // in one transaction so concurrent starts can't both win (BUG-10, BUG-11).
    const conn = await pool.getConnection();
    let priorStatus, machineId, metrics, outBlock, orderId;
    try {
      await conn.beginTransaction();

      const [taskRows] = await conn.query(
        `SELECT id, company_id, order_id, item_id, flow_id, seq_no,
                resource_type_id, assigned_resource_id, deps_cleared_at, status
           FROM fab_project_tasks
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL
          FOR UPDATE`,
        [taskId, companyId],
      );

      if (taskRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ message: `Task with id ${taskId} not found.` });
      }

      const task = taskRows[0];
      priorStatus = task.status;
      orderId = task.order_id;

      if (task.status !== 'eligible' && task.status !== 'paused') {
        await conn.rollback();
        return res.status(400).json({
          message: `Task cannot be started from status "${task.status}". Must be "eligible" or "paused".`,
        });
      }

      // ── BUG-09: resolve, validate and record the machine ─────────────────────
      machineId = requestedResourceId ?? task.assigned_resource_id ?? null;
      if (!machineId) {
        await conn.rollback();
        return res.status(400).json({ code: 'NO_MACHINE', message: 'Select a machine before starting this task.' });
      }
      const [machineRows] = await conn.query(
        `SELECT id, resource_type_id, plant_id, stock_location_id, name FROM fab_resources
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [machineId, companyId],
      );
      if (machineRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'Selected machine was not found.' });
      }
      const machine = machineRows[0];

      // A machine marked DOWN cannot run work. Until now machine state was read
      // only by analytics and after-the-fact wait attribution, so Start would
      // cheerfully begin a job on a machine the shop had just flagged as broken,
      // and those minutes were then attributed as downtime on a task that was
      // supposedly running. `force` is honoured for the same reason it is on the
      // buffer check: an admin reconciling the record with reality.
      const [[machineNow]] = await conn.query(
        `SELECT state, reason_code AS reasonCode FROM fab_resource_events
          WHERE company_id = ? AND resource_id = ? AND deleted_at IS NULL
            AND superseded_by_event_id IS NULL
          ORDER BY at DESC, id DESC LIMIT 1`,
        [companyId, machineId],
      );
      if (machineNow?.state === 'down' && !(forced && isAdmin)) {
        await conn.rollback();
        return res.status(409).json({
          code: 'MACHINE_DOWN',
          message: `${machine.name} is marked down${machineNow.reasonCode ? ` (${machineNow.reasonCode})` : ''}. Mark it back up before starting work on it.`,
        });
      }

      if (task.resource_type_id && machineRows[0].resource_type_id &&
          machineRows[0].resource_type_id !== task.resource_type_id) {
        await conn.rollback();
        return res.status(409).json({
          code: 'WRONG_MACHINE_TYPE',
          message: 'This task requires a machine of a different resource type.',
        });
      }

      // ── BUG-10: no machine double-booking. Lock the machine's in-progress rows. ─
      const [busyRows] = await conn.query(
        `SELECT id FROM fab_project_tasks
          WHERE company_id = ? AND assigned_resource_id = ? AND status = 'in_progress'
            AND deleted_at IS NULL AND id <> ? LIMIT 1 FOR UPDATE`,
        [companyId, machineId, taskId],
      );
      if (busyRows.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          code: 'MACHINE_BUSY',
          message: `That machine is already running task #${busyRows[0].id}. Finish or pause it first.`,
        });
      }

      // ── The busy rule (FAB_ERP_PEOPLE_PLAN.md §12) ───────────────────────────
      // A person may run any number of tasks on the machine they are assigned to,
      // and is blocked on every other machine. Their open `assigned` interval IS
      // their availability — there is no separate "busy" flag to keep in sync.
      //
      // Only fires when the caller NAMES workers. Starting without naming anyone
      // is the existing behaviour and stays working, because a Start button that
      // suddenly demanded a roster would simply stop being pressed.
      if (workerIds.length > 0) {
        const blocked = await workersBlockedElsewhere(conn, companyId, workerIds, machineId);
        if (blocked.length > 0 && !moveWorkers) {
          await conn.rollback();
          return res.status(409).json({
            code: 'WORKER_BUSY_ELSEWHERE',
            // Everything the UI needs to offer "Move them?" rather than a dead end.
            canMove: true,
            workers: blocked.map((b) => ({
              workerId: b.workerId, name: b.name,
              currentResourceId: b.currentResourceId, currentResourceName: b.currentResourceName,
            })),
            message: blocked.length === 1
              ? `${blocked[0].name} is on ${blocked[0].currentResourceName ?? 'another machine'}. Move them to ${machine.name} to start this here.`
              : `${blocked.length} people are on other machines. Move them to ${machine.name} to start this here.`,
          });
        }
        // Explicit opt-in: close their assignment on the old machine and open one
        // here. Done on THIS connection, not via assignWorker() — that helper
        // opens its own transaction and would commit the move independently, so
        // a later rollback of the start (insufficient stock, say) would leave the
        // person moved to a machine that never started anything.
        //
        // Closing the old interval is what stops them counting toward two
        // machines' crews at once, which would make `no_operator` quietly wrong
        // on the machine they actually left.
        for (const b of blocked) {
          await conn.query(
            `UPDATE fab_worker_assignments SET to_ts = UTC_TIMESTAMP()
              WHERE company_id = ? AND worker_id = ? AND kind = 'assigned'
                AND deleted_at IS NULL AND superseded_by_id IS NULL AND to_ts IS NULL`,
            [companyId, b.workerId],
          );
          await conn.query(
            `INSERT INTO fab_worker_assignments
               (company_id, worker_id, resource_id, kind, from_ts, entered_by, source, note)
             VALUES (?, ?, ?, 'assigned', UTC_TIMESTAMP(), ?, 'live', 'moved on task start')`,
            [companyId, b.workerId, machineId, user.id],
          );
          movedWorkers.push({ workerId: b.workerId, name: b.name, from: b.currentResourceName });
        }
      }

      // ── EU-8 output-blocked guard (unchanged behaviour, now machine-aware) ────
      outBlock = await isOutputBlocked(companyId, { ...task, assigned_resource_id: machineId }, conn);
      if (outBlock.blocked && !(forced && isAdmin)) {
        await conn.rollback();
        return res.status(409).json({ ok: false, code: 'OUTPUT_BLOCKED', message: outBlock.reason });
      }

      const now = new Date();
      metrics = await computeTaskWaitMetrics(task, now);

      // ── BUG-11: atomic transition — guard the UPDATE on the expected prior status ─
      const [updateResult] = await conn.query(
        `UPDATE fab_project_tasks
            SET wait_working_minutes = ?,
                blocked_by_other_tasks_minutes = ?,
                idle_wait_minutes = ?,
                assigned_resource_id = ?,
                started_at = UTC_TIMESTAMP(),
                status = 'in_progress'
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND status = ?`,
        [
          metrics.wait_working_minutes,
          metrics.blocked_by_other_tasks_minutes,
          metrics.idle_wait_minutes,
          machineId,
          taskId,
          companyId,
          priorStatus,
        ],
      );

      if (updateResult.affectedRows === 0) {
        await conn.rollback();
        return res.status(409).json({
          code: 'CONFLICT',
          message: 'Task state changed before it could start. Refresh and try again.',
        });
      }

      // BUG-01/02/07: consume this task's inputs (deduct, quantity-checked) and
      // open/move the node's WIP piece into this machine's stock area. A shortage
      // throws INSUFFICIENT_STOCK, which rolls the whole start back (below).
      // `task` carries id, item_id, seq_no, order_id from the SELECT above.
      await openOrMoveWipOnStart(conn, companyId, task, machine);

      // Record who is on this job. Anyone with no machine assignment is put on
      // this machine at the same time — starting work on a machine IS being on
      // it, and demanding a separate rostering step before Start worked would
      // guarantee the roster stayed empty.
      await attachWorkersToTask(conn, companyId, {
        taskId, workerIds, resourceId: machineId, enteredBy: user.id,
      });

      // BUG-03: reflect production progress on the order (best-effort, in-txn).
      await rollUpOrderStatus(conn, companyId, orderId);

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      if (txErr?.code === 'INSUFFICIENT_STOCK') {
        return res.status(409).json({ code: 'INSUFFICIENT_STOCK', message: txErr.message });
      }
      /**
       * Kept SEPARATE from a shortage, deliberately.
       *
       * "Not enough stock" invites somebody to go and buy more. This is not a
       * shortage — it is an item classified as something that never gets issued
       * as material (a machine, tooling, a spare), and the fix is to correct the
       * BOM or the classification, not the yard.
       */
      if (txErr?.code === 'NOT_CONSUMABLE') {
        return res.status(409).json({ code: 'NOT_CONSUMABLE', message: txErr.message });
      }
      throw txErr;
    } finally {
      conn.release();
    }

    await recordEvent({
      companyId,
      taskId,
      type: priorStatus === 'paused' ? 'resumed' : 'started',
      enteredBy: user.id,
    });

    // EU-8: audit an admin override of the output-blocked guard.
    if (outBlock.blocked && forced && isAdmin) {
      await recordEvent({
        companyId,
        taskId,
        type: 'state_note',
        source: 'live',
        enteredBy: user.id,
        note: `force-started while output_blocked: ${outBlock.reason}`,
      });
    }

    // EU-3: refresh wait attribution (fire-and-forget — never fails the response).
    recomputeTaskAttribution(companyId, taskId).catch((err) =>
      logger.error({ err, taskId }, 'attribution recompute failed'),
    );

    // EU-5: refresh CC buffer consumption for this order (fire-and-forget — a CC
    // recompute failure must never break the task lifecycle).
    if (orderId != null) {
      ccRecomputeForOrder(companyId, orderId).catch((err) =>
        logger.error({ err, taskId, orderId }, 'cc buffer recompute failed'),
      );
    }

    return res.status(200).json({
      ok: true,
      taskId,
      status: 'in_progress',
      assignedResourceId: machineId,
      workerIds,
      // Non-empty only when the caller opted into moving somebody; surfaced so
      // the UI can say "Ramesh was moved from Bay-3" rather than silently
      // relocating a person on the board behind them.
      movedWorkers,
      waitWorkingMinutes: metrics.wait_working_minutes,
      blockedByOtherTasksMinutes: metrics.blocked_by_other_tasks_minutes,
      idleWaitMinutes: metrics.idle_wait_minutes,
    });
  } catch (err) {
    logger.error({ err, companyId, taskId }, 'fab_erp tasks/start: unexpected error');
    return res.status(500).json({ message: 'Internal server error starting task.' });
  }
});

// ── POST /tasks/:id/pause ───────────────────────────────────────────────────
// EU-8: Task lifecycle — pause. Legal only from 'in_progress'.
// FEAT-12 (2026-07-24): optionally captures a downtime *reason* (why the task
// was paused), persisted to fab_project_tasks.delay_reason and onto the 'paused'
// event, so wait-time attribution can be grounded in reported causes.

const PAUSE_REASONS = new Set([
  'lack_of_manpower', 'machine_down', 'lack_of_consumable', 'planning_issue', 'minor_operational_delay',
]);

router.post('/tasks/:id/pause', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/pause: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const taskId = Number(req.params.id);

  if (!req.params.id || isNaN(taskId) || taskId <= 0) {
    return res.status(400).json({ message: 'Task id must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // FEAT-12: optional downtime reason. Empty/absent → null (unattributed pause).
  const rawReason = req.body?.reason;
  const reason = rawReason == null || rawReason === '' ? null : String(rawReason);
  if (reason !== null && !PAUSE_REASONS.has(reason)) {
    return res.status(400).json({ message: `reason must be one of: ${[...PAUSE_REASONS].join(', ')}.` });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    const [taskRows] = await pool.query(
      `SELECT id, status
         FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [taskId, companyId],
    );

    if (taskRows.length === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    const task = taskRows[0];

    if (task.status !== 'in_progress') {
      return res.status(400).json({
        message: `Task cannot be paused from status "${task.status}". Must be "in_progress".`,
      });
    }

    // BUG-11: gate the transition on the expected prior status so two concurrent
    // pause/stop calls can't both apply (affectedRows tells us who won).
    // FEAT-12: record the reported downtime reason on the task.
    const [updateResult] = await pool.query(
      `UPDATE fab_project_tasks
          SET paused_at = UTC_TIMESTAMP(),
              status = 'paused',
              delay_reason = ?
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND status = 'in_progress'`,
      [reason, taskId, companyId],
    );

    if (updateResult.affectedRows === 0) {
      return res.status(409).json({ code: 'CONFLICT', message: 'Task is no longer in progress. Refresh and try again.' });
    }

    // Close the worker intervals — they are no longer ON this job. Their MACHINE
    // assignment is deliberately left alone: pausing a job is not leaving the
    // machine, and unassigning here would make the station read as unmanned and
    // manufacture `no_operator` minutes out of an ordinary pause.
    await detachWorkersFromTask(pool, companyId, taskId);

    await recordEvent({ companyId, taskId, type: 'paused', enteredBy: user.id, note: reason });

    return res.status(200).json({ ok: true, taskId, status: 'paused', reason });
  } catch (err) {
    logger.error({ err, companyId, taskId }, 'fab_erp tasks/pause: unexpected error');
    return res.status(500).json({ message: 'Internal server error pausing task.' });
  }
});

// ── POST /tasks/:id/stop ────────────────────────────────────────────────────
// EU-8: Task lifecycle — stop (complete). Legal only from 'in_progress'.
// Sets status = 'done', completed_at = UTC_TIMESTAMP(), then calls taskEngineService's
// onTaskComplete(companyId, taskId) (EU-6) to cascade-clear downstream
// successors whose full predecessor set is now done.
//
// FEAT-05: optionally captures production output in the body — all fields
// optional, defaulting to a clean full-yield pass:
//   { producedQty?: number,   // good units; default = the item's planned qty
//     scrapQty?:    number,   // rejected units; default 0
//     qcResult?:    'pass'|'fail' }  // default 'pass'
// On 'pass' the WIP piece is finalised at the GOOD qty (scrap written off); on
// 'fail' no inventory is booked and a rework task is spawned as the node's new
// terminal step, so downstream stays gated until the rework passes QC.

router.post('/tasks/:id/stop', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/stop: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const taskId = Number(req.params.id);

  if (!req.params.id || isNaN(taskId) || taskId <= 0) {
    return res.status(400).json({ message: 'Task id must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // FEAT-05: optional production-output capture. Validate up front; actual
  // defaulting of producedQty needs the item's planned qty, resolved in the txn.
  const body = req.body || {};
  const hasProduced = body.producedQty != null && body.producedQty !== '';
  const hasScrap = body.scrapQty != null && body.scrapQty !== '';
  const producedQtyIn = hasProduced ? Number(body.producedQty) : null;
  const scrapQty = hasScrap ? Number(body.scrapQty) : 0;
  const qcResult = body.qcResult == null || body.qcResult === '' ? 'pass' : String(body.qcResult);

  if (hasProduced && (!Number.isFinite(producedQtyIn) || producedQtyIn < 0)) {
    return res.status(400).json({ message: 'producedQty must be a number ≥ 0.' });
  }
  if (!Number.isFinite(scrapQty) || scrapQty < 0) {
    return res.status(400).json({ message: 'scrapQty must be a number ≥ 0.' });
  }
  if (qcResult !== 'pass' && qcResult !== 'fail') {
    return res.status(400).json({ message: "qcResult must be 'pass' or 'fail'." });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    // Atomic complete + output capture + WIP finalize (goods-receipt of the
    // produced item) in one transaction, so completing a task always books its
    // inventory (BUG-01) and its production record (FEAT-05) together.
    let rework = null;      // { reworkTaskId, failedSeqNo } when QC failed
    let producedQty = producedQtyIn;
    let planHours = null;   // FEAT-16: this task's planned hours, for the variance readout
    let orderId = null;     // EU-5: captured for the post-commit CC buffer recompute
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [taskRows] = await conn.query(
        `SELECT t.id, t.order_id, t.item_id, t.seq_no, t.assigned_resource_id, t.status, t.computed_hours,
                t.setup_hours,
                t.task_qty,
                COALESCE(i.qty, 1) AS planned_qty
           FROM fab_project_tasks t
           LEFT JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id AND i.deleted_at IS NULL
          WHERE t.id = ? AND t.company_id = ? AND t.deleted_at IS NULL
          FOR UPDATE`,
        [taskId, companyId],
      );

      if (taskRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ message: `Task with id ${taskId} not found.` });
      }

      const task = taskRows[0];

      if (task.status !== 'in_progress') {
        await conn.rollback();
        return res.status(400).json({
          message: `Task cannot be stopped from status "${task.status}". Must be "in_progress".`,
        });
      }

      // Default good qty to the item's planned qty when the operator didn't report one.
      if (producedQty == null) producedQty = Number(task.planned_qty) || 1;
      planHours = taskHours(task); // FEAT-16 — the whole task, matching the actual it is compared against
      orderId = task.order_id;         // EU-5

      // BUG-11 + FEAT-05: gate the transition on the expected prior status
      // (atomic complete) and record the captured production output.
      const [updateResult] = await conn.query(
        `UPDATE fab_project_tasks
            SET status = 'done',
                completed_at = UTC_TIMESTAMP(),
                produced_qty = ?,
                scrap_qty = ?,
                qc_result = ?
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND status = 'in_progress'`,
        [producedQty, scrapQty, qcResult, taskId, companyId],
      );

      if (updateResult.affectedRows === 0) {
        await conn.rollback();
        return res.status(409).json({ code: 'CONFLICT', message: 'Task is no longer in progress. Refresh and try again.' });
      }

      if (qcResult === 'fail') {
        // FEAT-05: QC fail — book NO good inventory; spawn a rework task that
        // becomes the node's new terminal step, so the item is not "produced"
        // (and downstream stays gated) until the rework passes QC. The WIP piece
        // is intentionally left in 'wip' for the rework to finish.
        rework = await spawnReworkTask(conn, companyId, taskId);
      } else {
        // BUG-01 + FEAT-05: at the node's terminal step, finalize the WIP piece →
        // in_stock at the GOOD qty (transform up one BOM level); a top-level node
        // posts to Finished Goods. Scrap is written off for traceability.
        await finalizeWipOnComplete(conn, companyId, task, { goodQty: producedQty, scrapQty });
      }

      // Close the worker intervals in the SAME transaction as status='done', so
      // "the task finished" and "they stopped working on it" can never disagree.
      // Their machine assignment is left open on purpose — finishing a job is not
      // leaving the machine, and clearing it here would read as an unmanned
      // station between two jobs and invent `no_operator` minutes.
      await detachWorkersFromTask(conn, companyId, taskId);

      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }

    await recordEvent({ companyId, taskId, type: 'completed', enteredBy: user.id });

    // FEAT-05: audit the QC fail + rework spawn (recordEvent uses its own
    // connection, so this runs post-commit — same pattern as 'completed' above).
    if (rework) {
      await recordEvents([
        {
          companyId, taskId, type: 'state_note', source: 'live', enteredBy: user.id,
          note: `QC fail at completion — rework task ${rework.reworkTaskId} created`,
        },
        {
          companyId, taskId: rework.reworkTaskId, type: 'state_note', source: 'system',
          note: `rework of task ${taskId} (QC fail at seq ${rework.failedSeqNo})`,
        },
      ]);
    }

    // EU-3: refresh wait attribution (fire-and-forget — never fails the response).
    recomputeTaskAttribution(companyId, taskId).catch((err) =>
      logger.error({ err, taskId }, 'attribution recompute failed'),
    );

    // EU-5: refresh CC buffer consumption for this order now that a chain task
    // completed (fire-and-forget — never breaks the task lifecycle).
    if (orderId != null) {
      ccRecomputeForOrder(companyId, orderId).catch((err) =>
        logger.error({ err, taskId, orderId }, 'cc buffer recompute failed'),
      );
    }

    // A placeOutput() call sat here, appending to fab_buffer_contents on every
    // stop. That table is gone: finalizeWipOnComplete above already moved the
    // piece, and the buffer reads its load from where the piece now is.

    const engineResult = await onTaskComplete(companyId, taskId);

    // FEAT-16: plan-vs-actual variance for the just-completed task (the 'completed'
    // event is already recorded above, so touch time is computable). Best-effort.
    let variance = null;
    try {
      variance = await computeTaskVariance(pool, companyId, taskId, planHours);
    } catch (e) {
      logger.error({ err: e, taskId }, 'variance compute failed');
    }

    return res.status(200).json({
      ok: true,
      taskId,
      status: 'done',
      qcResult,
      producedQty,
      scrapQty,
      reworkTaskId: rework?.reworkTaskId ?? null,
      successorsCleared: engineResult.successorsCleared,
      variance,
    });
  } catch (err) {
    logger.error({ err, companyId, taskId }, 'fab_erp tasks/stop: unexpected error');
    return res.status(500).json({ message: 'Internal server error stopping task.' });
  }
});

// ── GET /tasks/:id/wait-breakdown ───────────────────────────────────────────
// EU-3: cause-classified wait segments + totals for one task. Auth mirrors the
// sibling task routes (admin bypass, else 'fab_erp_taskqueue_manage'). If the
// task has no segments yet but exists and is past created_at, we compute on the
// fly, then re-read. It's a GET, so it never shadows the POST /tasks/:id/... routes.

router.get('/tasks/:id/wait-breakdown', protect, async (req, res) => {
  const user = req.user;

  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);
    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/wait-breakdown: permission denied',
      );
      return res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
    }
  }

  const taskId = Number(req.params.id);
  if (!req.params.id || isNaN(taskId) || taskId <= 0) {
    return res.status(400).json({ message: 'Task id must be a positive integer.' });
  }

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const loadSegments = async () => {
      const [rows] = await pool.query(
        // blocker_* names WHAT was holding the task during each pre-eligibility
        // slice — the difference between "waiting on predecessors" and "waiting on
        // the weld consumable spool since Tuesday".
        `SELECT reason, seg_start, seg_end, working_minutes,
                blocker_type AS blockerType, blocker_ref_id AS blockerRefId,
                blocker_label AS blockerLabel
           FROM fab_task_wait_segments
          WHERE company_id = ? AND task_id = ? AND deleted_at IS NULL
          ORDER BY seg_start ASC`,
        [companyId, taskId],
      );
      return rows;
    };

    let rows = await loadSegments();

    if (rows.length === 0) {
      const [taskRows] = await pool.query(
        `SELECT id, created_at FROM fab_project_tasks
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL
          LIMIT 1`,
        [taskId, companyId],
      );
      if (taskRows.length === 0) {
        return res.status(404).json({ message: `Task with id ${taskId} not found.` });
      }
      const createdAt = taskRows[0].created_at ? new Date(taskRows[0].created_at) : null;
      if (createdAt && createdAt < new Date()) {
        await recomputeTaskAttribution(companyId, taskId);
        rows = await loadSegments();
      }
    }

    const totals = {};
    let totalWaitMinutes = 0;
    for (const r of rows) {
      const wm = Number(r.working_minutes) || 0;
      totals[r.reason] = (totals[r.reason] || 0) + wm;
      totalWaitMinutes += wm;
    }

    return res.status(200).json({
      ok: true,
      taskId,
      totals,
      totalWaitMinutes,
      segments: rows.map((r) => ({
        reason: r.reason,
        segStart: r.seg_start,
        segEnd: r.seg_end,
        workingMinutes: Number(r.working_minutes) || 0,
      })),
    });
  } catch (err) {
    logger.error({ err, companyId, taskId }, 'fab_erp tasks/wait-breakdown: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching wait breakdown.' });
  }
});

// ── POST /tasks/:id/events/backfill ─────────────────────────────────────────
// EU-10: enter a full past lifecycle (started → pauses → completed) in one call.
// Distinct suffix from the /tasks/:id/start|pause|stop POSTs, so no route clash.
//
// Validation philosophy: shop-floor times go MISSING when a form rejects messy
// input, so we WARN-AND-FLAG (warnings[]) rather than reject for calendar/overlap
// anomalies. We HARD-reject (400) only for logically-impossible orderings:
// completed_at <= started_at; a pause outside [started_at, completed_at];
// resumed_at <= its paused_at.

router.post('/tasks/:id/events/backfill', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_time_backfill';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp tasks/events/backfill: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const taskId = Number(req.params.id);

  if (!req.params.id || isNaN(taskId) || taskId <= 0) {
    return res.status(400).json({ message: 'Task id must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const { started_at, completed_at, pauses, note } = req.body ?? {};

  const startedDate = started_at ? new Date(started_at) : null;
  if (!startedDate || isNaN(startedDate.getTime())) {
    return res.status(400).json({ message: 'started_at is required and must be a valid datetime.' });
  }

  let completedDate = null;
  if (completed_at !== undefined && completed_at !== null && completed_at !== '') {
    completedDate = new Date(completed_at);
    if (isNaN(completedDate.getTime())) {
      return res.status(400).json({ message: 'completed_at must be a valid datetime.' });
    }
    // HARD reject: a completed task must finish strictly after it started.
    if (completedDate.getTime() <= startedDate.getTime()) {
      return res.status(400).json({ message: 'completed_at must be after started_at.' });
    }
  }

  const pauseList = Array.isArray(pauses) ? pauses : [];
  const parsedPauses = [];
  for (const p of pauseList) {
    const pausedDate = p?.paused_at ? new Date(p.paused_at) : null;
    if (!pausedDate || isNaN(pausedDate.getTime())) {
      return res.status(400).json({ message: 'Each pause requires a valid paused_at.' });
    }
    let resumedDate = null;
    if (p?.resumed_at !== undefined && p?.resumed_at !== null && p?.resumed_at !== '') {
      resumedDate = new Date(p.resumed_at);
      if (isNaN(resumedDate.getTime())) {
        return res.status(400).json({ message: 'resumed_at must be a valid datetime.' });
      }
      // HARD reject: a resume must come strictly after its pause.
      if (resumedDate.getTime() <= pausedDate.getTime()) {
        return res.status(400).json({ message: 'resumed_at must be after paused_at.' });
      }
    }
    // HARD reject: a pause must fall within [started_at, completed_at].
    if (pausedDate.getTime() < startedDate.getTime()) {
      return res.status(400).json({ message: 'A pause falls before started_at.' });
    }
    if (completedDate &&
        (pausedDate.getTime() > completedDate.getTime() ||
         (resumedDate && resumedDate.getTime() > completedDate.getTime()))) {
      return res.status(400).json({ message: 'A pause falls after completed_at.' });
    }
    parsedPauses.push({ pausedDate, resumedDate });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    const [taskRows] = await pool.query(
      `SELECT id, company_id, resource_type_id, assigned_resource_id, status
         FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [taskId, companyId],
    );

    if (taskRows.length === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    const task = taskRows[0];

    // ── Soft validation → warnings[] (never rejects) ─────────────────────────
    const warnings = [];
    const now = new Date();

    const calendarIds = await resolveTaskCalendarIds(companyId, task);

    if (calendarIds.length > 0) {
      const checks = [['started_at', startedDate]];
      for (const pp of parsedPauses) {
        checks.push(['paused_at', pp.pausedDate]);
        if (pp.resumedDate) checks.push(['resumed_at', pp.resumedDate]);
      }
      if (completedDate) checks.push(['completed_at', completedDate]);

      for (const [label, d] of checks) {
        if (await timestampOutsideShift(companyId, calendarIds, d)) {
          warnings.push(`${label} (${d.toISOString()}) falls outside the task's shift calendar.`);
        }
      }
    }

    const overlapEnd = completedDate || now;
    const overlaps = await fetchOverlappingOtherTasks(companyId, task, startedDate, overlapEnd, now);
    if (overlaps.length > 0) {
      warnings.push(`[started_at, completed_at] overlaps ${overlaps.length} other task(s) on the same machine.`);
    }

    // ── Write events (source 'backfill', entered_by = req.user.id) ───────────
    const events = [];
    events.push({ companyId, taskId, type: 'started', at: toSqlUtc(startedDate), source: 'backfill', enteredBy: user.id, note: note ?? null });
    for (const pp of parsedPauses) {
      events.push({ companyId, taskId, type: 'paused', at: toSqlUtc(pp.pausedDate), source: 'backfill', enteredBy: user.id, note: note ?? null });
      if (pp.resumedDate) {
        events.push({ companyId, taskId, type: 'resumed', at: toSqlUtc(pp.resumedDate), source: 'backfill', enteredBy: user.id, note: note ?? null });
      }
    }
    if (completedDate) {
      events.push({ companyId, taskId, type: 'completed', at: toSqlUtc(completedDate), source: 'backfill', enteredBy: user.id, note: note ?? null });
    }
    await recordEvents(events);

    // ── Mirror timestamp columns + status onto fab_project_tasks ─────────────
    // (keeps the row consistent with its events, like the live start/stop routes)
    const lastPausedAt = parsedPauses.length > 0
      ? toSqlUtc(parsedPauses[parsedPauses.length - 1].pausedDate)
      : null;
    const newStatus = completedDate ? 'done' : 'in_progress';

    await pool.query(
      `UPDATE fab_project_tasks
          SET started_at = ?,
              paused_at = ?,
              completed_at = ?,
              status = ?
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [
        toSqlUtc(startedDate),
        lastPausedAt,
        completedDate ? toSqlUtc(completedDate) : null,
        newStatus,
        taskId,
        companyId,
      ],
    );

    // ── Refresh attribution (fire-and-forget); also fix neighbors' busy math ─
    recomputeTaskAttribution(companyId, taskId).catch((err) =>
      logger.error({ err, taskId }, 'attribution recompute failed'),
    );
    if (task.assigned_resource_id) {
      recomputeForResource(companyId, task.assigned_resource_id, new Date()).catch((err) =>
        logger.error({ err, resourceId: task.assigned_resource_id }, 'resource attribution recompute failed'),
      );
    }

    return res.status(200).json({ ok: true, warnings });
  } catch (err) {
    logger.error({ err, companyId, taskId }, 'fab_erp tasks/events/backfill: unexpected error');
    return res.status(500).json({ message: 'Internal server error during task backfill.' });
  }
});

// ── POST /task-events/:eventId/correct ──────────────────────────────────────
// EU-10: correct one event's timestamp WITHOUT in-place edit — insert a new
// event and mark the old row superseded (append-only audit). Mounted as a
// sibling of /tasks/*; the '/task-events/' prefix guarantees no path clash.

router.post('/task-events/:eventId/correct', protect, async (req, res) => {
  const user = req.user;

  // ── Authorization ──────────────────────────────────────────────────────────
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';

  if (!isAdmin) {
    const REQUIRED_TAG = 'fab_erp_time_backfill';
    const granted =
      Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);

    if (!granted) {
      logger.warn(
        { userId: user?.id, requiredTag: REQUIRED_TAG },
        'fab_erp task-events/correct: permission denied',
      );
      return res.status(403).json({
        message: `Permission denied. Required: "${REQUIRED_TAG}".`,
      });
    }
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const eventId = Number(req.params.eventId);

  if (!req.params.eventId || isNaN(eventId) || eventId <= 0) {
    return res.status(400).json({ message: 'Event id must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const { at, note } = req.body ?? {};
  const atDate = at ? new Date(at) : null;
  if (!atDate || isNaN(atDate.getTime())) {
    return res.status(400).json({ message: 'at is required and must be a valid datetime.' });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    const [eventRows] = await pool.query(
      `SELECT id, task_id, event_type
         FROM fab_task_events
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND superseded_by_event_id IS NULL
        LIMIT 1`,
      [eventId, companyId],
    );

    if (eventRows.length === 0) {
      return res.status(404).json({ message: `Event with id ${eventId} not found or already superseded.` });
    }

    const evt = eventRows[0];
    const taskId = evt.task_id;
    const newAtSql = toSqlUtc(atDate);

    // Insert-new + set-superseded in one transaction (throws on genuine DB error).
    const { oldEventId, newEventId } = await supersedeEvent({
      companyId,
      oldEventId: eventId,
      newAt: newAtSql,
      enteredBy: user.id,
      note: note ?? null,
    });

    // Mirror the corrected value onto the task's matching timestamp column.
    const COLUMN_BY_EVENT = {
      started: 'started_at',
      paused: 'paused_at',
      resumed: 'started_at',
      completed: 'completed_at',
      deps_cleared: 'deps_cleared_at',
      queued: 'queued_at',
    };
    const col = COLUMN_BY_EVENT[evt.event_type];
    if (col) {
      await pool.query(
        `UPDATE fab_project_tasks SET ${col} = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [newAtSql, taskId, companyId],
      );
    }

    // ── Warnings for the corrected time (shift + overlap on same machine) ────
    const warnings = [];
    const now = new Date();
    const [taskRows] = await pool.query(
      `SELECT id, company_id, resource_type_id, assigned_resource_id
         FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [taskId, companyId],
    );
    const task = taskRows[0];
    if (task) {
      const calendarIds = await resolveTaskCalendarIds(companyId, task);
      if (calendarIds.length > 0 && (await timestampOutsideShift(companyId, calendarIds, atDate))) {
        warnings.push(`Corrected time (${atDate.toISOString()}) falls outside the task's shift calendar.`);
      }
      const overlaps = await fetchOverlappingOtherTasks(
        companyId, task, atDate, new Date(atDate.getTime() + 60000), now,
      );
      if (overlaps.length > 0) {
        warnings.push(`Corrected time overlaps ${overlaps.length} other task(s) on the same machine.`);
      }
    }

    recomputeTaskAttribution(companyId, taskId).catch((err) =>
      logger.error({ err, taskId }, 'attribution recompute failed'),
    );
    if (task?.assigned_resource_id) {
      recomputeForResource(companyId, task.assigned_resource_id, new Date()).catch((err) =>
        logger.error({ err, resourceId: task.assigned_resource_id }, 'resource attribution recompute failed'),
      );
    }

    return res.status(200).json({ ok: true, oldEventId, newEventId, warnings });
  } catch (err) {
    logger.error({ err, companyId, eventId }, 'fab_erp task-events/correct: unexpected error');
    return res.status(500).json({ message: 'Internal server error correcting event.' });
  }
});

export default router;
