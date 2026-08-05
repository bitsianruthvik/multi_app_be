/**
 * routes/criticalChain.js
 * ------------------------
 * EU-4 (Critical Chain): exposes EU-3's baseline builder as a route so a
 * planner can (re)baseline an order on demand. materializeTasks also calls
 * buildBaseline automatically for sales orders (see taskInstanceService.js);
 * this route lets it be triggered manually too (e.g. after a manual
 * reschedule or resource-capacity change).
 *
 * EU-6 adds the read side: a fleet-wide portfolio view and a per-plan detail
 * view (chain tasks, buffers, fever trail) — gated by the separate
 * 'fab_erp_cc_view' tag rather than '_manage'.
 *
 * Mounted under /api/:companySlug/fab_erp
 *
 * Permission: 'fab_erp_cc_manage' for the baseline route; 'fab_erp_cc_view'
 * for the read routes — admins bypass as usual.
 *
 * Routes:
 *   POST /cc/plans/:orderId/baseline — (re)build + persist the CCPM baseline
 *     for one order. Returns buildBaseline's result verbatim as JSON.
 *   GET  /cc/portfolio — one row per baselined sales-order plan, fever-sorted.
 *   GET  /cc/plans/:orderId — the active baselined plan for one order, with
 *     its chain tasks, buffers, and fever (buffer-consumption) trail.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { buildBaseline } from '../services/criticalChainService.js';
import { replan as drumReplan } from '../services/drumService.js';
import { whatIf } from '../services/ccWhatIfService.js';
import { pool } from '../../../db.js';

const router = Router();

const REQUIRED_TAG = 'fab_erp_cc_manage';
const VIEW_TAG = 'fab_erp_cc_view';

/**
 * Shared authz check — admin bypass, else require `tag` in uiPermissions.
 * `tag` defaults to REQUIRED_TAG so the existing baseline route (which calls
 * this with one argument) is unaffected.
 */
function isAuthorized(user, tag = REQUIRED_TAG) {
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
}

function denyPermission(res, user, routeLabel, tag = REQUIRED_TAG) {
  logger.warn(
    { userId: user?.id, requiredTag: tag },
    `fab_erp ${routeLabel}: permission denied`,
  );
  return res.status(403).json({ message: `Permission denied. Required: "${tag}".` });
}

// ── POST /cc/plans/:orderId/baseline ────────────────────────────────────────

router.post('/cc/plans/:orderId/baseline', protect, async (req, res) => {
  const user = req.user;

  if (!isAuthorized(user)) return denyPermission(res, user, 'cc/plans/:orderId/baseline');

  const orderId = Number(req.params.orderId);
  if (!req.params.orderId || isNaN(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'orderId must be a positive integer.' });
  }

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const result = await buildBaseline({ companyId, orderId });
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp cc/plans/:orderId/baseline: unexpected error');
    return res.status(500).json({ message: 'Internal server error building baseline.' });
  }
});

/** Whole calendar days between two DATETIME-ish values (b − a), rounded. */
function dayDelta(a, b) {
  if (a == null || b == null) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

const ZONE_RANK = { red: 0, yellow: 1, green: 2 };

// ── POST /cc/replan ─────────────────────────────────────────────────────────
// Re-detect the drum and re-sequence every baselined sales order on it. Only
// replan events (this route, a new project materializing, a re-materialize)
// re-solve the drum — never per task event.

router.post('/cc/replan', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, REQUIRED_TAG)) return denyPermission(res, user, 'cc/replan', REQUIRED_TAG);

  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const result = await drumReplan(companyId);
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp cc/replan: unexpected error');
    return res.status(500).json({ message: 'Internal server error running portfolio replan.' });
  }
});

// ── GET /cc/portfolio ───────────────────────────────────────────────────────
// One row per baselined sales-order plan. Most at-risk (red, then largest
// slip) first. deltaDays > 0 = committed finish is AFTER the promised date.

router.get('/cc/portfolio', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, user, 'cc/portfolio', VIEW_TAG);

  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const [rows] = await pool.query(
      `SELECT p.id            AS planId,
              p.order_id       AS orderId,
              p.committed_finish AS committedFinish,
              p.projected_finish AS projectedFinish,
              p.due_date       AS dueDate,
              p.fever_zone     AS feverZone,
              p.buffer_consumed_pct AS bufferConsumedPct,
              p.chain_complete_pct  AS chainCompletePct,
              p.drum_planned_start  AS drumPlannedStart,
              o.order_number   AS orderNumber,
              c.name           AS customerName,
              ds.seq           AS drumSeq
         FROM fab_cc_plans p
         JOIN fab_orders o
           ON o.id = p.order_id AND o.company_id = p.company_id AND o.deleted_at IS NULL
         LEFT JOIN fab_customers c
           ON c.id = o.customer_id AND c.company_id = p.company_id AND c.deleted_at IS NULL
         LEFT JOIN fab_cc_drum_slots ds
           ON ds.plan_id = p.id AND ds.company_id = p.company_id AND ds.deleted_at IS NULL
        WHERE p.company_id = ? AND p.status = 'baselined' AND p.deleted_at IS NULL`,
      [companyId],
    );

    const projects = rows.map((r) => ({
      planId: r.planId,
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      customerName: r.customerName ?? null,
      committedFinish: r.committedFinish,
      dueDate: r.dueDate,
      deltaDays: dayDelta(r.dueDate, r.committedFinish),
      feverZone: r.feverZone,
      bufferConsumedPct: r.bufferConsumedPct,
      chainCompletePct: r.chainCompletePct,
      drumPlannedStart: r.drumPlannedStart,
      drumSeq: r.drumSeq ?? null,
    }));

    projects.sort((a, b) => {
      const za = ZONE_RANK[a.feverZone] ?? 3;
      const zb = ZONE_RANK[b.feverZone] ?? 3;
      if (za !== zb) return za - zb;
      return (b.deltaDays ?? -Infinity) - (a.deltaDays ?? -Infinity);
    });

    return res.status(200).json({ ok: true, projects });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp cc/portfolio: unexpected error');
    return res.status(500).json({ message: 'Internal server error loading portfolio.' });
  }
});

// ── GET /cc/plans/:orderId ──────────────────────────────────────────────────
// The active (latest baselined) plan for an order plus its chain tasks,
// buffers, and fever-snapshot trail.

router.get('/cc/plans/:orderId', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, user, 'cc/plans/:orderId', VIEW_TAG);

  const orderId = Number(req.params.orderId);
  if (!req.params.orderId || isNaN(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'orderId must be a positive integer.' });
  }
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const [[planRow]] = await pool.query(
      `SELECT id            AS id,
              order_id       AS orderId,
              status         AS status,
              due_date       AS dueDate,
              chain_length_minutes   AS chainLengthMinutes,
              project_buffer_minutes AS projectBufferMinutes,
              aggressive_finish AS aggressiveFinish,
              committed_finish  AS committedFinish,
              projected_finish  AS projectedFinish,
              fever_zone        AS feverZone,
              buffer_consumed_pct AS bufferConsumedPct,
              chain_complete_pct  AS chainCompletePct,
              drum_planned_start  AS drumPlannedStart,
              baselined_at        AS baselinedAt
         FROM fab_cc_plans
        WHERE company_id = ? AND order_id = ? AND status = 'baselined' AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [companyId, orderId],
    );

    if (!planRow) return res.status(404).json({ ok: false, message: 'No baselined plan for this order.' });

    const planId = planRow.id;

    const [chainRows] = await pool.query(
      `SELECT ct.task_id        AS taskId,
              ct.seq            AS seq,
              ct.chain_role     AS chainRole,
              ct.feeding_group_id AS feedingGroupId,
              ct.aggressive_minutes AS aggressiveMinutes,
              ct.planned_start  AS plannedStart,
              ct.planned_end    AS plannedEnd,
              t.status          AS status,
              t.operation_id    AS operationId,
              t.item_id         AS itemId,
              op.name           AS operationName
         FROM fab_cc_chain_tasks ct
         LEFT JOIN fab_project_tasks t
           ON t.id = ct.task_id AND t.company_id = ct.company_id
         LEFT JOIN fab_operations op
           ON op.id = t.operation_id AND op.company_id = ct.company_id AND op.deleted_at IS NULL
        WHERE ct.company_id = ? AND ct.plan_id = ? AND ct.deleted_at IS NULL
        ORDER BY ct.chain_role ASC, ct.seq ASC, ct.task_id ASC`,
      [companyId, planId],
    );

    const [bufRows] = await pool.query(
      `SELECT kind AS kind, size_minutes AS sizeMinutes, consumed_minutes AS consumedMinutes,
              feeds_task_id AS feedsTaskId, after_task_id AS afterTaskId,
              warn_pct AS warnPct, act_pct AS actPct
         FROM fab_cc_buffers
        WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL`,
      [companyId, planId],
    );

    const [trailRows] = await pool.query(
      `SELECT at AS at, chain_complete_pct AS chainCompletePct,
              buffer_consumed_pct AS bufferConsumedPct, zone AS zone
         FROM fab_cc_buffer_snapshots
        WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL
        ORDER BY at ASC`,
      [companyId, planId],
    );

    const buffers = bufRows.map((b) => ({
      kind: b.kind,
      sizeMinutes: b.sizeMinutes,
      consumedMinutes: b.consumedMinutes,
      consumedPct: b.sizeMinutes > 0 ? Math.round((100 * b.consumedMinutes) / b.sizeMinutes) : 0,
      feedsTaskId: b.feedsTaskId,
      afterTaskId: b.afterTaskId,
      warnPct: b.warnPct,
      actPct: b.actPct,
    }));

    return res.status(200).json({
      ok: true,
      plan: planRow,
      chainTasks: chainRows,
      buffers,
      feverTrail: trailRows,
    });
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp cc/plans/:orderId: unexpected error');
    return res.status(500).json({ message: 'Internal server error loading plan.' });
  }
});

// ── GET /cc/drum ────────────────────────────────────────────────────────────
// The current constraint (drum) + its sequenced slot timeline. Feeds the drum
// panel banner + rope strip on the Critical Chain page.

router.get('/cc/drum', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, user, 'cc/drum', VIEW_TAG);

  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    const [[drum]] = await pool.query(
      `SELECT d.id AS drumId, d.resource_type_id AS resourceTypeId, d.load_minutes AS loadMinutes,
              d.computed_at AS computedAt, rt.name AS resourceTypeName
         FROM fab_cc_drum d
         LEFT JOIN fab_resource_types rt
           ON rt.id = d.resource_type_id AND rt.company_id = d.company_id AND rt.deleted_at IS NULL
        WHERE d.company_id = ? AND d.deleted_at IS NULL
        LIMIT 1`,
      [companyId],
    );

    if (!drum) return res.status(200).json({ ok: true, drum: null, slots: [] });

    const [slots] = await pool.query(
      `SELECT ds.order_id AS orderId, o.order_number AS orderNumber, ds.seq AS seq,
              ds.planned_start AS plannedStart, ds.planned_end AS plannedEnd,
              ds.capacity_buffer_minutes AS capacityBufferMinutes,
              ds.is_committed AS isCommitted
         FROM fab_cc_drum_slots ds
         JOIN fab_orders o ON o.id = ds.order_id AND o.company_id = ds.company_id
        WHERE ds.company_id = ? AND ds.drum_id = ? AND ds.deleted_at IS NULL
        ORDER BY ds.seq ASC`,
      [companyId, drum.drumId],
    );

    return res.status(200).json({
      ok: true,
      drum: {
        drumId: drum.drumId,
        resourceTypeId: drum.resourceTypeId,
        resourceTypeName: drum.resourceTypeName ?? null,
        loadMinutes: drum.loadMinutes,
        computedAt: drum.computedAt,
      },
      slots: slots.map((s) => ({ ...s, isCommitted: Number(s.isCommitted) === 1 })),
    });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp cc/drum: unexpected error');
    return res.status(500).json({ message: 'Internal server error loading drum.' });
  }
});

// ── GET /cc/alerts ──────────────────────────────────────────────────────────
// Derived (no alerts table): (a) projects whose fever zone worsened between their
// two latest snapshots, and (b) near-term drum wake-ups (a drum slot starting
// within the next 24h). Feeds the Operate nav badge + the alerts strip.

router.get('/cc/alerts', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, user, 'cc/alerts', VIEW_TAG);

  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  try {
    // Two most recent snapshots per baselined plan → detect a worsening transition.
    const [snaps] = await pool.query(
      `SELECT s.plan_id, s.at, s.zone, o.order_number AS orderNumber, p.order_id AS orderId,
              ROW_NUMBER() OVER (PARTITION BY s.plan_id ORDER BY s.at DESC) AS rn
         FROM fab_cc_buffer_snapshots s
         JOIN fab_cc_plans p ON p.id = s.plan_id AND p.status = 'baselined' AND p.deleted_at IS NULL
         JOIN fab_orders o ON o.id = p.order_id AND o.company_id = p.company_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL`,
      [companyId],
    );
    const byPlan = new Map();
    for (const r of snaps) {
      if (r.rn > 2) continue;
      if (!byPlan.has(r.plan_id)) byPlan.set(r.plan_id, {});
      const slot = byPlan.get(r.plan_id);
      if (r.rn === 1) { slot.current = r; } else { slot.prev = r; }
    }
    const alerts = [];
    for (const { current, prev } of byPlan.values()) {
      if (!current || !prev) continue;
      const worsened = (ZONE_RANK[current.zone] ?? 3) < (ZONE_RANK[prev.zone] ?? 3);
      if (!worsened) continue;
      alerts.push({
        type: 'zone',
        severity: current.zone,
        orderId: current.orderId,
        orderNumber: current.orderNumber,
        fromZone: prev.zone,
        toZone: current.zone,
        at: current.at,
        message: `${current.orderNumber} buffer moved ${prev.zone} → ${current.zone}`,
      });
    }

    // Near-term drum wake-ups: a slot starting within the next 24h.
    const [slots] = await pool.query(
      `SELECT ds.order_id AS orderId, ds.planned_start AS plannedStart, ds.seq AS seq,
              o.order_number AS orderNumber, rt.name AS drumName
         FROM fab_cc_drum_slots ds
         JOIN fab_cc_drum d ON d.id = ds.drum_id AND d.company_id = ds.company_id AND d.deleted_at IS NULL
         LEFT JOIN fab_resource_types rt ON rt.id = d.resource_type_id AND rt.company_id = ds.company_id
         JOIN fab_orders o ON o.id = ds.order_id AND o.company_id = ds.company_id
        WHERE ds.company_id = ? AND ds.deleted_at IS NULL
          AND ds.planned_start IS NOT NULL
          AND ds.planned_start BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 24 HOUR)`,
      [companyId],
    );
    for (const s of slots) {
      alerts.push({
        type: 'wakeup',
        severity: 'info',
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        drumName: s.drumName ?? null,
        at: s.plannedStart,
        message: `${s.drumName ? s.drumName + ': ' : ''}${s.orderNumber} reaches the constraint soon`,
      });
    }

    return res.status(200).json({ ok: true, alerts });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp cc/alerts: unexpected error');
    return res.status(500).json({ message: 'Internal server error loading alerts.' });
  }
});

// ── GET /cc/whatif ──────────────────────────────────────────────────────────
// Detour preview: would starting ?taskId on ?resourceId push any project? Called
// by the Task Queue Start flow before the actual start (EU-13).

router.get('/cc/whatif', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) return denyPermission(res, user, 'cc/whatif', VIEW_TAG);

  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const taskId = Number(req.query.taskId);
  if (!req.query.taskId || isNaN(taskId) || taskId <= 0) {
    return res.status(400).json({ message: 'taskId query param must be a positive integer.' });
  }
  const resourceId = req.query.resourceId != null && req.query.resourceId !== ''
    ? Number(req.query.resourceId) : null;

  try {
    const result = await whatIf({ companyId, taskId, resourceId: Number.isNaN(resourceId) ? null : resourceId });
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, companyId, taskId, resourceId }, 'fab_erp cc/whatif: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing detour impact.' });
  }
});

export default router;
