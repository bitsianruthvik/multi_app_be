/**
 * routes/buffers.js
 * -----------------
 * EU-7: Buffer board (per-machine load) + one-tap material move.
 * EU-9: Buffer configuration endpoints (create/update/soft-delete a machine's
 * input/output buffer).
 *
 * Mounted under /api/:companySlug/fab_erp (via routes/index.js).
 *
 * The board/move routes are gated behind 'fab_erp_taskqueue_manage' (operators
 * moving material); the config routes are gated behind 'fab_erp_buffer_config'
 * (planners/admins shaping the buffer model). Both apply the usual admin bypass.
 *
 * Routes:
 *   GET  /buffers/board
 *     Per machine (resource) that has any active buffer:
 *       { resourceId, resourceName,
 *         input:  { load, capacity, pct, status } | null,
 *         output: { load, capacity, pct, status } | null }
 *     status ∈ ok|warn|block by pct vs the buffer's warn_pct / block_pct.
 *     Set-based (no N+1).
 *
 *   POST /buffers/move
 *     Body: { contentId?, taskId?, toBufferId? }
 *       - toBufferId omitted → resolved via resolveNextInputBuffer(task).
 *       - contentId omitted but taskId given → that task's open output-buffer content.
 *     Returns 200 { ok, movedContentId, fromBufferId, toBufferId }
 *          or 400 { message } when no source/destination resolves.
 *
 *   GET  /buffers/config?resourceId=
 *     Both buffer rows (input/output, active or not) for one machine.
 *     Returns 200 { ok, buffers: [{id, resourceId, kind, stockLocationId,
 *       capacityValue, capacityUom, weightMetricKey, warnPct, blockPct, active}] }
 *
 *   POST /buffers/config
 *     Upsert one (resourceId, kind) buffer. Body: { resourceId, kind,
 *       stockLocationId?, capacityValue, capacityUom?, weightMetricKey?,
 *       warnPct?, blockPct?, active? }. stockLocationId defaults to the
 *     machine's own fab_resources.stock_location_id when omitted.
 *     Returns 200 { ok, id } or 400 { message } on validation failure.
 *
 *   DELETE /buffers/config/:id
 *     Soft-deletes one company-scoped buffer row. Returns 200 { ok } or
 *     404 { message } when no matching row exists.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';
import {
  deriveLoad,
  moveContent,
  resolveNextInputBuffer,
  statusFor,
  BufferMoveError,
} from '../services/bufferService.js';

const router = Router();

const REQUIRED_TAG = 'fab_erp_taskqueue_manage';
const CONFIG_TAG = 'fab_erp_buffer_config';

/** admin bypass, else require `requiredTag`. Returns true when allowed. */
function authorize(req, res, routeName, requiredTag = REQUIRED_TAG) {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  const granted =
    Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(requiredTag);
  if (!granted) {
    logger.warn({ userId: user?.id, requiredTag }, `fab_erp ${routeName}: permission denied`);
    res.status(403).json({ message: `Permission denied. Required: "${requiredTag}".` });
    return false;
  }
  return true;
}

// ── GET /buffers/board ────────────────────────────────────────────────────────

router.get('/buffers/board', protect, async (req, res) => {
  if (!authorize(req, res, 'buffers/board')) return;

  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    // 1. all active buffers for the company
    const [buffers] = await pool.query(
      `SELECT id, resource_id, kind, capacity_value, capacity_uom, warn_pct, block_pct
         FROM fab_buffers
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL`,
      [companyId],
    );
    if (buffers.length === 0) return res.status(200).json({ ok: true, machines: [] });

    const bufferIds = buffers.map((b) => b.id);
    const resourceIds = [...new Set(buffers.map((b) => b.resource_id))];

    // 2. one grouped aggregate over open contents for ALL buffers (no N+1)
    const [aggRows] = await pool.query(
      `SELECT buffer_id,
              SUM(computed_weight)   AS weightSum,
              SUM(qty)               AS qtySum,
              COUNT(*)               AS cnt,
              COUNT(computed_weight) AS weightCnt
         FROM fab_buffer_contents
        WHERE company_id = ? AND buffer_id IN (?) AND moved_out_at IS NULL AND deleted_at IS NULL
        GROUP BY buffer_id`,
      [companyId, bufferIds],
    );
    const aggByBuffer = new Map(aggRows.map((r) => [r.buffer_id, r]));

    // 3. resource names in one query
    const [resRows] = await pool.query(
      `SELECT id, name FROM fab_resources
        WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
      [companyId, resourceIds],
    );
    const nameByResource = new Map(resRows.map((r) => [r.id, r.name]));

    // 4. assemble per-resource, reusing bufferService's load rule (one source of truth)
    const sideOf = (buffer) => {
      const { load, capacity, pct } = deriveLoad(buffer, aggByBuffer.get(buffer.id) || {});
      return { load, capacity, pct, status: statusFor(pct, buffer.warn_pct, buffer.block_pct) };
    };

    const byResource = new Map();
    for (const b of buffers) {
      if (!byResource.has(b.resource_id)) {
        byResource.set(b.resource_id, {
          resourceId: b.resource_id,
          resourceName: nameByResource.get(b.resource_id) ?? null,
          input: null,
          output: null,
        });
      }
      byResource.get(b.resource_id)[b.kind] = sideOf(b);
    }

    return res.status(200).json({ ok: true, machines: [...byResource.values()] });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp buffers/board: unexpected error');
    return res.status(500).json({ message: 'Internal server error building buffer board.' });
  }
});

// ── POST /buffers/move ──────────────────────────────────────────────────────

router.post('/buffers/move', protect, async (req, res) => {
  if (!authorize(req, res, 'buffers/move')) return;

  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const body = req.body || {};
  const contentId = body.contentId != null ? Number(body.contentId) : null;
  const taskId = body.taskId != null ? Number(body.taskId) : null;
  let toBufferId = body.toBufferId != null ? Number(body.toBufferId) : null;

  if (contentId == null && taskId == null) {
    return res.status(400).json({ message: 'Provide contentId or taskId.' });
  }

  try {
    // 1. resolve the source open content row
    let resolvedContentId = contentId;
    let sourceTask = null;

    if (resolvedContentId == null) {
      // taskId given → find its open OUTPUT-buffer content
      const [[content]] = await pool.query(
        `SELECT c.id FROM fab_buffer_contents c
           JOIN fab_buffers b ON b.id = c.buffer_id AND b.kind = 'output' AND b.deleted_at IS NULL
          WHERE c.company_id = ? AND c.task_id = ? AND c.moved_out_at IS NULL AND c.deleted_at IS NULL
          ORDER BY c.placed_at DESC LIMIT 1`,
        [companyId, taskId],
      );
      if (!content) {
        return res.status(400).json({ message: `No open output-buffer content found for task ${taskId}.` });
      }
      resolvedContentId = content.id;
    }

    // 2. resolve the destination buffer if not supplied
    if (toBufferId == null) {
      // need the task to resolve the next machine's input buffer
      let taskForResolve = taskId;
      if (taskForResolve == null) {
        const [[c]] = await pool.query(
          `SELECT task_id FROM fab_buffer_contents
            WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
          [resolvedContentId, companyId],
        );
        taskForResolve = c ? c.task_id : null;
      }
      if (taskForResolve == null) {
        return res.status(400).json({
          message: 'No toBufferId given and the content has no task to resolve a destination from.',
        });
      }
      const destBuffer = await resolveNextInputBuffer(companyId, { id: taskForResolve });
      if (!destBuffer) {
        return res.status(400).json({
          message: 'Could not resolve a next input buffer (no downstream machine with an input buffer).',
        });
      }
      toBufferId = destBuffer.id;
      sourceTask = taskForResolve;
    }

    // 3. perform the move
    const result = await moveContent(companyId, { contentId: resolvedContentId, toBufferId });
    return res.status(200).json({
      ok: true,
      movedContentId: result.movedContentId,
      newContentId: result.newContentId,
      fromBufferId: result.fromBufferId,
      toBufferId: result.toBufferId,
      ...(sourceTask != null ? { taskId: sourceTask } : {}),
    });
  } catch (err) {
    if (err instanceof BufferMoveError) {
      return res.status(400).json({ message: err.message });
    }
    logger.error({ err, companyId }, 'fab_erp buffers/move: unexpected error');
    return res.status(500).json({ message: 'Internal server error moving buffer content.' });
  }
});

// ── GET /buffers/config?resourceId= ─────────────────────────────────────────

router.get('/buffers/config', protect, async (req, res) => {
  if (!authorize(req, res, 'buffers/config GET', CONFIG_TAG)) return;

  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const resourceId = req.query.resourceId != null ? Number(req.query.resourceId) : null;
  if (!resourceId || !Number.isFinite(resourceId)) {
    return res.status(400).json({ message: 'resourceId query parameter is required.' });
  }

  try {
    // Deliberately no `active` filter here — config UI needs to see (and toggle)
    // inactive buffers too. deleted_at IS NULL is the only soft-delete exclusion.
    const [rows] = await pool.query(
      `SELECT id, resource_id, kind, stock_location_id, capacity_value, capacity_uom,
              weight_metric_key, warn_pct, block_pct, active
         FROM fab_buffers
        WHERE company_id = ? AND resource_id = ? AND deleted_at IS NULL
        ORDER BY kind`,
      [companyId, resourceId],
    );

    const buffers = rows.map((r) => ({
      id: r.id,
      resourceId: r.resource_id,
      kind: r.kind,
      stockLocationId: r.stock_location_id,
      capacityValue: r.capacity_value,
      capacityUom: r.capacity_uom,
      weightMetricKey: r.weight_metric_key,
      warnPct: r.warn_pct,
      blockPct: r.block_pct,
      active: !!r.active,
    }));

    return res.status(200).json({ ok: true, buffers });
  } catch (err) {
    logger.error({ err, companyId, resourceId }, 'fab_erp buffers/config GET: unexpected error');
    return res.status(500).json({ message: 'Internal server error loading buffer config.' });
  }
});

// ── POST /buffers/config ────────────────────────────────────────────────────

router.post('/buffers/config', protect, async (req, res) => {
  if (!authorize(req, res, 'buffers/config POST', CONFIG_TAG)) return;

  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const body = req.body || {};
  const resourceId = body.resourceId != null ? Number(body.resourceId) : null;
  const kind = body.kind;
  const capacityValue = body.capacityValue != null ? Number(body.capacityValue) : null;
  const capacityUom = body.capacityUom ? String(body.capacityUom).trim() : 'kg';
  const weightMetricKey = body.weightMetricKey ? String(body.weightMetricKey).trim() : 'unit_weight_kg';
  const warnPct = body.warnPct != null ? Number(body.warnPct) : 80;
  const blockPct = body.blockPct != null ? Number(body.blockPct) : 100;
  const active = body.active != null ? (body.active ? 1 : 0) : 1;

  if (!resourceId || !Number.isFinite(resourceId)) {
    return res.status(400).json({ message: 'resourceId is required.' });
  }
  if (kind !== 'input' && kind !== 'output') {
    return res.status(400).json({ message: `kind must be "input" or "output", got "${kind}".` });
  }
  if (capacityValue == null || !Number.isFinite(capacityValue) || capacityValue <= 0) {
    return res.status(400).json({ message: 'capacityValue must be a positive number.' });
  }
  if (
    !Number.isFinite(warnPct) || !Number.isFinite(blockPct) ||
    warnPct <= 0 || blockPct > 100 || warnPct > blockPct
  ) {
    return res.status(400).json({ message: 'Percent thresholds must satisfy 0 < warnPct <= blockPct <= 100.' });
  }

  try {
    // stockLocationId defaults to the machine's own stock location.
    let stockLocationId = body.stockLocationId != null ? Number(body.stockLocationId) : null;
    if (stockLocationId == null) {
      const [[resource]] = await pool.query(
        `SELECT stock_location_id FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [resourceId, companyId],
      );
      if (!resource) return res.status(400).json({ message: `Resource ${resourceId} not found.` });
      stockLocationId = resource.stock_location_id;
    }

    const [[existing]] = await pool.query(
      `SELECT id FROM fab_buffers WHERE company_id = ? AND resource_id = ? AND kind = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, resourceId, kind],
    );

    let id;
    if (existing) {
      id = existing.id;
      await pool.query(
        `UPDATE fab_buffers
            SET stock_location_id = ?, capacity_value = ?, capacity_uom = ?, weight_metric_key = ?,
                warn_pct = ?, block_pct = ?, active = ?, updated_at = NOW()
          WHERE id = ? AND company_id = ?`,
        [stockLocationId, capacityValue, capacityUom, weightMetricKey, warnPct, blockPct, active, id, companyId],
      );
    } else {
      const [ins] = await pool.query(
        `INSERT INTO fab_buffers
           (company_id, resource_id, kind, stock_location_id, capacity_value, capacity_uom,
            weight_metric_key, warn_pct, block_pct, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, resourceId, kind, stockLocationId, capacityValue, capacityUom, weightMetricKey, warnPct, blockPct, active],
      );
      id = ins.insertId;
    }

    return res.status(200).json({ ok: true, id });
  } catch (err) {
    logger.error({ err, companyId, body }, 'fab_erp buffers/config POST: unexpected error');
    return res.status(500).json({ message: 'Internal server error saving buffer config.' });
  }
});

// ── DELETE /buffers/config/:id ──────────────────────────────────────────────

router.delete('/buffers/config/:id', protect, async (req, res) => {
  if (!authorize(req, res, 'buffers/config DELETE', CONFIG_TAG)) return;

  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const id = Number(req.params.id);
  if (!id || !Number.isFinite(id)) {
    return res.status(400).json({ message: 'Invalid buffer id.' });
  }

  try {
    const [result] = await pool.query(
      `UPDATE fab_buffers SET deleted_at = NOW() WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [id, companyId],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: `Buffer ${id} not found.` });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, companyId, id }, 'fab_erp buffers/config DELETE: unexpected error');
    return res.status(500).json({ message: 'Internal server error deleting buffer config.' });
  }
});

export default router;
