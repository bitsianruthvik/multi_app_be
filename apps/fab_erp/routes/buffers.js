/**
 * routes/buffers.js
 * -----------------
 * EU-7: Buffer board (per-machine load).
 * EU-9: Buffer configuration endpoints (create/update/soft-delete a machine's
 * input/output buffer).
 *
 * Mounted under /api/:companySlug/fab_erp (via routes/index.js).
 *
 * The board route is gated behind 'fab_erp_taskqueue_manage'; the config routes are gated behind 'fab_erp_buffer_config'
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
  resolveNextInputBuffer,
  statusFor,
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
      `SELECT id, resource_id, kind, stock_location_id, weight_metric_key,
              capacity_value, capacity_uom, warn_pct, block_pct
         FROM fab_buffers
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL`,
      [companyId],
    );
    if (buffers.length === 0) return res.status(200).json({ ok: true, machines: [] });

    const resourceIds = [...new Set(buffers.map((b) => b.resource_id))];

    // 2. one grouped aggregate over the WIP standing at each machine's stock
    //    area, for ALL buffers at once (no N+1).
    //
    //    Grouped by RESOURCE, not by buffer: a machine has one WIP location, so
    //    its input and output buffers both measure the same pile. That is the
    //    honest limitation of deriving load from stock rather than from a
    //    separate placement ledger — the stock model records where a piece is,
    //    not which side of a machine it is waiting on. Splitting the two needs
    //    "pieces whose next eligible task is assigned here", which is a
    //    different query and a later job.
    //
    //    Location resolution mirrors bufferService.bufferLocationId EXACTLY —
    //    the buffer's own stock_location_id when set, else the machine's
    //    WIP-M<id> area by code. The code fallback matters because
    //    stock_location_id is a copy taken at config time and is NULL for any
    //    buffer configured before its machine first ran. Resolving differently
    //    here would let this board and the gating check disagree about how full
    //    the same machine is.
    const [locRows] = await pool.query(
      `SELECT id, code FROM fab_stock_locations
        WHERE company_id = ? AND code IN (?) AND deleted_at IS NULL`,
      [companyId, resourceIds.map((rid) => `WIP-M${rid}`.slice(0, 20))],
    );
    const locIdByCode = new Map(locRows.map((l) => [l.code, l.id]));
    const locIdOf = (b) =>
      b.stock_location_id ?? locIdByCode.get(`WIP-M${b.resource_id}`.slice(0, 20)) ?? null;

    //    Weights are summed per metric key, because each buffer may measure its
    //    capacity with a different one. In practice they all use unit_weight_kg,
    //    so this is one extra query in the degenerate case and correct in the
    //    general one.
    const locIds = [...new Set(buffers.map(locIdOf).filter((v) => v != null))];
    const metricKeys = [...new Set(buffers.map((b) => b.weight_metric_key || 'unit_weight_kg'))];
    const aggByLocationAndKey = new Map(); // `${locId}|${key}` -> agg row
    if (locIds.length) {
      for (const key of metricKeys) {
        const [aggRows] = await pool.query(
          `SELECT p.stock_location_id           AS locId,
                  SUM(p.qty * v.metric_value)   AS weightSum,
                  SUM(p.qty)                    AS qtySum,
                  COUNT(*)                      AS cnt,
                  COUNT(v.metric_value)         AS weightCnt
             FROM fab_stock_pieces p
             LEFT JOIN fab_item_metric_values v
                    ON v.item_id = p.wip_item_id AND v.company_id = p.company_id
                   AND v.metric_key = ? AND v.deleted_at IS NULL
            WHERE p.company_id = ? AND p.stock_location_id IN (?)
              AND p.status = 'wip' AND p.deleted_at IS NULL
            GROUP BY p.stock_location_id`,
          [key, companyId, locIds],
        );
        for (const r of aggRows) aggByLocationAndKey.set(`${r.locId}|${key}`, r);
      }
    }
    const aggByBuffer = new Map(
      buffers.map((b) => [
        b.id,
        aggByLocationAndKey.get(`${locIdOf(b)}|${b.weight_metric_key || 'unit_weight_kg'}`) ?? {},
      ]),
    );

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
// POST /buffers/move was here. It was the only thing that ever closed a
// fab_buffer_contents row, and that table is gone: what a machine holds is
// read from fab_stock_pieces, which wipInventoryService moves on task start.
// A buffer no longer needs an operator to tell it something left.


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
