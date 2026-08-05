/**
 * routes/dispatch.js — production planning: what each machine works on next.
 *
 * Mounted separately at app.js alongside routes/criticalChain.js rather than
 * folded into routes/index.js, matching that precedent.
 *
 * Deliberately two steps. GET /dispatch/preview computes a ranking and writes
 * nothing; POST /dispatch/confirm persists exactly what was shown. A ranking
 * that took effect the moment it was computed would give the planner no place
 * to stand — the inputs move constantly, so what they approve has to be a
 * specific frozen list, not "whatever the algorithm says at the time".
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { computeDispatch, confirmDispatch } from '../services/dispatchService.js';

const router = Router();

const VIEW_TAG = 'fab_erp_taskqueue_view';
const MANAGE_TAG = 'fab_erp_projects_manage';

function isAuthorized(user, tag) {
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
}

function denyPermission(res, tag) {
  return res.status(403).json({ message: `Permission denied. Required: "${tag}".` });
}

/**
 * GET /dispatch/preview — the ranking, computed fresh. Writes nothing.
 *
 * `limitPerMachine` caps how deep each machine's list goes; the default of 5 is
 * about what an operator can hold in mind for one shift.
 */
router.get('/dispatch/preview', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);

  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const raw = Number(req.query.limitPerMachine);
  const limitPerMachine = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 25) : 5;

  try {
    const computed = await computeDispatch(companyId, { limitPerMachine });
    return res.status(200).json({ ok: true, ...computed });
  } catch (err) {
    logger.error({ err, companyId }, 'dispatch preview failed');
    return res.status(500).json({ message: 'Failed to compute dispatch.' });
  }
});

/**
 * POST /dispatch/confirm — recompute and persist as a confirmed run.
 *
 * Recomputes rather than accepting the client's list: a payload of task ids is
 * a payload a client can edit, and the persisted run is meant to be evidence of
 * what the system recommended. The response reports the run so the caller can
 * show what was actually stored if it drifted from the preview.
 */
router.post('/dispatch/confirm', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, MANAGE_TAG)) return denyPermission(res, MANAGE_TAG);

  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const raw = Number(req.body?.limitPerMachine);
  const limitPerMachine = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 25) : 5;

  try {
    const computed = await computeDispatch(companyId, { limitPerMachine });
    const saved = await confirmDispatch(companyId, computed, user.id);
    logger.info({ companyId, userId: user.id, ...saved }, 'dispatch run confirmed');
    return res.status(201).json({ ok: true, ...saved, machines: computed.machines });
  } catch (err) {
    logger.error({ err, companyId }, 'dispatch confirm failed');
    return res.status(500).json({ message: 'Failed to confirm dispatch.' });
  }
});

/**
 * GET /dispatch/latest — the most recent confirmed run, as stored.
 *
 * Reads the frozen component scores rather than recomputing, so it answers
 * "what were the machines actually told, and why" after the inputs have moved.
 */
router.get('/dispatch/latest', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, VIEW_TAG);

  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const { pool } = await import('../../../db.js');
    const [[run]] = await pool.query(
      `SELECT id, computed_at AS computedAt, confirmed_at AS confirmedAt,
              confirmed_by AS confirmedBy, machine_count AS machineCount,
              task_count AS taskCount
         FROM fab_dispatch_runs
        WHERE company_id = ? AND status = 'confirmed' AND deleted_at IS NULL
        ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
      [companyId],
    );
    if (!run) return res.status(200).json({ ok: true, run: null, machines: [] });

    const [items] = await pool.query(
      `SELECT i.resource_id AS resourceId, r.name AS resourceName,
              i.task_id AS taskId, i.order_id AS orderId,
              i.rank_in_machine AS rankInMachine, i.order_slack_minutes AS orderSlackMinutes,
              i.is_critical_chain AS isCriticalChain, i.seq_no AS seqNo, i.reason,
              op.name AS operationName, o.order_number AS orderNumber
         FROM fab_dispatch_run_items i
         LEFT JOIN fab_resources r      ON r.id = i.resource_id
         LEFT JOIN fab_project_tasks t  ON t.id = i.task_id
         LEFT JOIN fab_operations op    ON op.id = t.operation_id
         LEFT JOIN fab_orders o         ON o.id = i.order_id
        WHERE i.company_id = ? AND i.run_id = ? AND i.deleted_at IS NULL
        ORDER BY r.name ASC, i.rank_in_machine ASC`,
      [companyId, run.id],
    );

    const byResource = new Map();
    for (const it of items) {
      if (!byResource.has(it.resourceId)) {
        byResource.set(it.resourceId, { resourceId: it.resourceId, resourceName: it.resourceName, tasks: [] });
      }
      // Selected as rankInMachine because RANK is a reserved word (window
      // function) in MySQL 8 and TiDB and an unquoted alias is a syntax error.
      // Renamed here so this endpoint and /dispatch/preview return one shape.
      const { rankInMachine, ...rest } = it;
      byResource.get(it.resourceId).tasks.push({ ...rest, rank: rankInMachine });
    }

    return res.status(200).json({ ok: true, run, machines: [...byResource.values()] });
  } catch (err) {
    logger.error({ err, companyId }, 'dispatch latest failed');
    return res.status(500).json({ message: 'Failed to load the latest dispatch run.' });
  }
});

export default router;
