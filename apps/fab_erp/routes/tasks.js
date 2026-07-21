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
import { recordEvent } from '../services/taskEventService.js';
import { materializeTasks } from '../services/taskInstanceService.js';
import { computeTaskWaitMetrics } from '../services/taskWaitService.js';
import { onTaskComplete } from '../services/taskEngineService.js';
import { recomputeTaskAttribution } from '../services/taskAttributionService.js';

const router = Router();

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
        t.seq_no AS seqNo,
        t.status,
        t.deps_cleared_at AS depsClearedAt,
        t.wait_working_minutes AS waitWorkingMinutes,
        t.blocked_by_other_tasks_minutes AS blockedByOtherTasksMinutes,
        t.idle_wait_minutes AS idleWaitMinutes,
        t.delay_reason AS delayReason,
        t.computed_hours AS computedHours,
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

    // Count tasks by status
    const counts = {
      eligible: taskRows.filter(t => t.status === 'eligible').length,
      in_progress: taskRows.filter(t => t.status === 'in_progress').length,
      paused: taskRows.filter(t => t.status === 'paused').length,
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
// as of now, then persists those three fields alongside started_at = NOW()
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

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    const [taskRows] = await pool.query(
      `SELECT id, company_id, resource_type_id, assigned_resource_id,
              deps_cleared_at, status
         FROM fab_project_tasks
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [taskId, companyId],
    );

    if (taskRows.length === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    const task = taskRows[0];

    if (task.status !== 'eligible' && task.status !== 'paused') {
      return res.status(400).json({
        message: `Task cannot be started from status "${task.status}". Must be "eligible" or "paused".`,
      });
    }

    const priorStatus = task.status;
    const now = new Date();
    const metrics = await computeTaskWaitMetrics(task, now);

    const [updateResult] = await pool.query(
      `UPDATE fab_project_tasks
          SET wait_working_minutes = ?,
              blocked_by_other_tasks_minutes = ?,
              idle_wait_minutes = ?,
              started_at = NOW(),
              status = 'in_progress'
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [
        metrics.wait_working_minutes,
        metrics.blocked_by_other_tasks_minutes,
        metrics.idle_wait_minutes,
        taskId,
        companyId,
      ],
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    await recordEvent({
      companyId,
      taskId,
      type: priorStatus === 'paused' ? 'resumed' : 'started',
      enteredBy: user.id,
    });

    // EU-3: refresh wait attribution (fire-and-forget — never fails the response).
    recomputeTaskAttribution(companyId, taskId).catch((err) =>
      logger.error({ err, taskId }, 'attribution recompute failed'),
    );

    return res.status(200).json({
      ok: true,
      taskId,
      status: 'in_progress',
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
// EU-8: Task lifecycle — pause. No delay reason accepted/required (delay
// reasons are only captured on start/resume, per spec). Legal only from
// 'in_progress'.

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

    const [updateResult] = await pool.query(
      `UPDATE fab_project_tasks
          SET paused_at = NOW(),
              status = 'paused'
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [taskId, companyId],
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    await recordEvent({ companyId, taskId, type: 'paused', enteredBy: user.id });

    return res.status(200).json({ ok: true, taskId, status: 'paused' });
  } catch (err) {
    logger.error({ err, companyId, taskId }, 'fab_erp tasks/pause: unexpected error');
    return res.status(500).json({ message: 'Internal server error pausing task.' });
  }
});

// ── POST /tasks/:id/stop ────────────────────────────────────────────────────
// EU-8: Task lifecycle — stop (complete). Legal only from 'in_progress'.
// Sets status = 'done', completed_at = NOW(), then calls taskEngineService's
// onTaskComplete(companyId, taskId) (EU-6) to cascade-clear downstream
// successors whose full predecessor set is now done.

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
        message: `Task cannot be stopped from status "${task.status}". Must be "in_progress".`,
      });
    }

    const [updateResult] = await pool.query(
      `UPDATE fab_project_tasks
          SET status = 'done',
              completed_at = NOW()
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [taskId, companyId],
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    await recordEvent({ companyId, taskId, type: 'completed', enteredBy: user.id });

    // EU-3: refresh wait attribution (fire-and-forget — never fails the response).
    recomputeTaskAttribution(companyId, taskId).catch((err) =>
      logger.error({ err, taskId }, 'attribution recompute failed'),
    );

    const engineResult = await onTaskComplete(companyId, taskId);

    return res.status(200).json({
      ok: true,
      taskId,
      status: 'done',
      successorsCleared: engineResult.successorsCleared,
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
        `SELECT reason, seg_start, seg_end, working_minutes
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

export default router;
