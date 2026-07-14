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
 *     Body: { projectId }
 *     Auth: JWT required (protect middleware).
 *     Authz: req.user.role === 'admin'  OR
 *            req.user.uiPermissions includes 'fab_erp_taskqueue_manage'
 *     Calls: materializeTasks(companyId, projectId)
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
import { materializeTasks } from '../services/taskInstanceService.js';
import { computeTaskWaitMetrics } from '../services/taskWaitService.js';
import { onTaskComplete } from '../services/taskEngineService.js';

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
        t.project_id AS projectId,
        p.name AS projectName,
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
      LEFT JOIN fab_projects p ON t.project_id = p.id
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
  const { projectId } = req.body ?? {};

  if (projectId === undefined || projectId === null || isNaN(Number(projectId))) {
    return res.status(400).json({ message: 'projectId is required and must be a number.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Call service ───────────────────────────────────────────────────────────
  try {
    const result = await materializeTasks(companyId, Number(projectId));

    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId, projectId }, 'fab_erp tasks/materialize: unexpected error');
    return res.status(500).json({ message: 'Internal server error during task materialization.' });
  }
});

// ── GET /tasks/graph ────────────────────────────────────────────────────────
// EU-11: project-wide task DAG (all fab_items instances of a project in one
// response — one DAG per project, not per item, per design).
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
  const { projectId } = req.query;
  const pid = Number(projectId);

  if (!projectId || isNaN(pid) || pid <= 0) {
    return res.status(400).json({ message: 'projectId query param is required and must be a positive integer.' });
  }

  const companyId = user.companyId;

  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  // ── Query logic ────────────────────────────────────────────────────────────
  try {
    const [taskRows] = await pool.query(
      `SELECT
         t.id,
         t.operation_id AS operationId,
         op.name AS operationName,
         t.item_id AS itemId,
         it.name AS itemName,
         t.flow_id AS flowId,
         t.seq_no AS seqNo,
         t.depends_on AS dependsOn,
         t.status,
         t.resource_type_id AS resourceTypeId,
         t.assigned_resource_id AS assignedResourceId,
         t.started_at AS startedAt,
         t.paused_at AS pausedAt,
         t.completed_at AS completedAt,
         t.computed_hours AS computedHours
       FROM fab_project_tasks t
       LEFT JOIN fab_operations op ON t.operation_id = op.id
       LEFT JOIN fab_items it ON t.item_id = it.id
       WHERE t.company_id = ? AND t.project_id = ? AND t.deleted_at IS NULL
       ORDER BY t.item_id ASC, t.flow_id ASC, t.seq_no ASC, t.id ASC`,
      [companyId, pid],
    );

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
          if (fromId != null) edges.push({ from: fromId, to: row.id });
        }
      }
    }

    const nodes = taskRows.map((r) => ({
      id: r.id,
      operationId: r.operationId,
      operationName: r.operationName,
      itemId: r.itemId,
      itemName: r.itemName,
      flowId: r.flowId,
      seqNo: r.seqNo,
      status: r.status,
      dependsOn: r.dependsOn,
      resourceTypeId: r.resourceTypeId,
      assignedResourceId: r.assignedResourceId,
      startedAt: r.startedAt,
      pausedAt: r.pausedAt,
      completedAt: r.completedAt,
      computedHours: r.computedHours,
    }));

    return res.status(200).json({ ok: true, nodes, edges });
  } catch (err) {
    logger.error({ err, companyId, projectId }, 'fab_erp tasks/graph: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching project task graph.' });
  }
});

// ── POST /tasks/:id/start ───────────────────────────────────────────────────
// EU-8: Task lifecycle — start.
//
// Requires a `delay_reason` in the body, one of the fixed
// fab_project_tasks.delay_reason ENUM values. Legal from status 'eligible'
// (first start) or 'paused' (resume) — both require a fresh delay_reason,
// since resuming after a pause is itself a delay event that needs its own
// reason recorded, exactly like the initial start.
//
// Calls taskWaitService's computeTaskWaitMetrics(task, now) to compute
// wait_working_minutes / blocked_by_other_tasks_minutes / idle_wait_minutes
// as of now, then persists those three fields alongside delay_reason,
// started_at = NOW(), and status = 'in_progress'.

const DELAY_REASONS = [
  'lack_of_manpower',
  'machine_down',
  'lack_of_consumable',
  'planning_issue',
  'minor_operational_delay',
];

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

  const { delay_reason } = req.body ?? {};

  if (!delay_reason || !DELAY_REASONS.includes(delay_reason)) {
    return res.status(400).json({
      message: `delay_reason is required and must be one of: ${DELAY_REASONS.join(', ')}.`,
    });
  }

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

    const now = new Date();
    const metrics = await computeTaskWaitMetrics(task, now);

    const [updateResult] = await pool.query(
      `UPDATE fab_project_tasks
          SET wait_working_minutes = ?,
              blocked_by_other_tasks_minutes = ?,
              idle_wait_minutes = ?,
              delay_reason = ?,
              started_at = NOW(),
              status = 'in_progress'
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [
        metrics.wait_working_minutes,
        metrics.blocked_by_other_tasks_minutes,
        metrics.idle_wait_minutes,
        delay_reason,
        taskId,
        companyId,
      ],
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ message: `Task with id ${taskId} not found.` });
    }

    return res.status(200).json({
      ok: true,
      taskId,
      status: 'in_progress',
      delayReason: delay_reason,
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

export default router;
