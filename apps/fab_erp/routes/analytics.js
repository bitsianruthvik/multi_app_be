/**
 * routes/analytics.js
 * -------------------
 * EU-16: Shop-floor analytics dashboard — the read-only aggregate layer over
 * the Phase 1-3 shop-floor tables (machine-state events, wait segments, buffer
 * snapshots, project tasks + task events). Everything here is computed ON READ
 * with dedicated set-based aggregate SQL (NOT the generic query API) — there is
 * no nightly rollup and nothing is cached, so numbers are always fresh.
 *
 * Mounted under /api/:companySlug/fab_erp (via routes/index.js). All endpoints
 * are company-scoped and accept a ?from=&to= date range (default: last 30 days).
 *
 * Permission: every endpoint requires the 'fab_erp_shopfloor_analytics_view'
 * tag; admins bypass — same helper pattern as routes/reconciliation.js /
 * routes/machineState.js.
 *
 * Routes:
 *   GET /analytics/machines           — per-machine time-in-state + utilization
 *                                       + current input-buffer pct.
 *   GET /analytics/constraint         — rank machines by a constraint heuristic;
 *                                       returns the top machine + the ranking.
 *   GET /analytics/wait-pareto        — total wait working-minutes by reason
 *                                       (optionally scoped to one order).
 *   GET /analytics/project/:orderId   — per-item + order touch-time vs wait-time.
 *
 * Divide-by-zero is guarded everywhere (0 / null, never NaN).
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';

const router = Router();

const REQUIRED_TAG = 'fab_erp_shopfloor_analytics_view';

const DEFAULT_RANGE_DAYS = 30;
const MS_PER_DAY = 86400000;

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

/** Format a Date as a MySQL 'YYYY-MM-DD HH:MM:SS' string (local time). */
function toSqlDatetime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Parse ?from=&to= into MySQL datetime strings. Accepts date-only (YYYY-MM-DD,
 * expanded to the full day) or any Date-parseable datetime. Defaults to the
 * last 30 days. `effectiveTo` is clamped to now — future time can never count
 * toward a machine's time-in-state.
 */
function parseRange(query) {
  const now = new Date();
  const rawFrom = typeof query.from === 'string' ? query.from.trim() : '';
  const rawTo = typeof query.to === 'string' ? query.to.trim() : '';
  const dateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  let to = rawTo ? new Date(dateOnly(rawTo) ? `${rawTo}T23:59:59` : rawTo) : now;
  if (isNaN(to.getTime())) to = now;

  let from = rawFrom
    ? new Date(dateOnly(rawFrom) ? `${rawFrom}T00:00:00` : rawFrom)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);
  if (isNaN(from.getTime())) from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);

  const effectiveTo = to.getTime() > now.getTime() ? now : to;

  return {
    fromSql: toSqlDatetime(from),
    toSql: toSqlDatetime(to),
    effectiveToSql: toSqlDatetime(effectiveTo),
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

function round(n, dp = 0) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ── shared aggregate builders (each company-scoped, set-based, no N+1) ────────

/**
 * Time-in-state minutes per machine over [from, effectiveTo]. Walks consecutive
 * fab_resource_events: each event's state runs until the next event (or the
 * window end for the still-open latest state), clipped to the window. Uses only
 * non-superseded, non-deleted events — mirrors GET /machines/board. Returns a
 * Map<resourceId, {running,idle,down,off}> in minutes (integers).
 *
 * Note: 'no_shift' time is NOT derived here — that would require resolving each
 * machine's shift calendar and walking shift intervals per machine (the exact
 * heavy calendar join deferred elsewhere in this app). Off-shift idle simply
 * falls into whatever explicit state the machine was left in ('idle'/'off').
 */
async function fetchStateMinutes(companyId, fromSql, effectiveToSql) {
  const [rows] = await pool.query(
    `WITH ev AS (
       SELECT resource_id, state, at,
              LEAD(at) OVER (PARTITION BY resource_id ORDER BY at, id) AS next_at
         FROM fab_resource_events
        WHERE company_id = ? AND deleted_at IS NULL AND superseded_by_event_id IS NULL
          AND at <= ?
     )
     SELECT resource_id AS resourceId, state,
            SUM(GREATEST(0, TIMESTAMPDIFF(SECOND,
                  GREATEST(at, ?),
                  LEAST(COALESCE(next_at, ?), ?)))) AS seconds
       FROM ev
      GROUP BY resource_id, state`,
    [companyId, effectiveToSql, fromSql, effectiveToSql, effectiveToSql],
  );

  const byResource = new Map();
  for (const r of rows) {
    if (!byResource.has(r.resourceId)) {
      byResource.set(r.resourceId, { running: 0, idle: 0, down: 0, off: 0 });
    }
    const bucket = byResource.get(r.resourceId);
    if (r.state in bucket) bucket[r.state] = round(Number(r.seconds) / 60);
  }
  return byResource;
}

/**
 * Latest input-buffer fullness pct per machine, as of `asOfSql`. One row per
 * active input buffer, taking its most recent snapshot at/before the window
 * end. Returns Map<resourceId, pct(number)>.
 */
async function fetchInputBufferPct(companyId, asOfSql) {
  const [rows] = await pool.query(
    `SELECT b.resource_id AS resourceId, s.pct AS pct
       FROM fab_buffers b
       JOIN (
         SELECT buffer_id, pct,
                ROW_NUMBER() OVER (PARTITION BY buffer_id ORDER BY at DESC, id DESC) AS rn
           FROM fab_buffer_level_snapshots
          WHERE company_id = ? AND deleted_at IS NULL AND at <= ?
       ) s ON s.buffer_id = b.id AND s.rn = 1
      WHERE b.company_id = ? AND b.kind = 'input' AND b.active = 1 AND b.deleted_at IS NULL`,
    [companyId, asOfSql, companyId],
  );

  const byResource = new Map();
  for (const r of rows) {
    if (r.pct != null) byResource.set(r.resourceId, Number(r.pct));
  }
  return byResource;
}

/**
 * Build the per-machine analytics rows (shared by /machines and /constraint).
 * utilizationPct = running / (running + idle + down) — 'off' (unscheduled) is
 * excluded from the denominator; guarded to 0 when the machine has no logged
 * running/idle/down time in-range.
 */
async function buildMachineRows(companyId, range) {
  const [resources] = await pool.query(
    `SELECT id, name FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY name ASC`,
    [companyId],
  );

  const [stateByResource, bufferByResource] = await Promise.all([
    fetchStateMinutes(companyId, range.fromSql, range.effectiveToSql),
    fetchInputBufferPct(companyId, range.effectiveToSql),
  ]);

  return resources.map((r) => {
    const st = stateByResource.get(r.id) ?? { running: 0, idle: 0, down: 0, off: 0 };
    const denom = st.running + st.idle + st.down;
    const utilizationPct = denom > 0 ? round((st.running / denom) * 100, 1) : 0;
    const inputBufferPct = bufferByResource.has(r.id) ? round(bufferByResource.get(r.id), 1) : null;
    return {
      resourceId: r.id,
      name: r.name,
      states: st,
      utilizationPct,
      inputBufferPct,
    };
  });
}

// ── GET /analytics/machines ─────────────────────────────────────────────────

router.get('/analytics/machines', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'analytics/machines');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const range = parseRange(req.query);
    const machines = await buildMachineRows(companyId, range);
    return res.status(200).json({ ok: true, from: range.fromIso, to: range.toIso, machines });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp analytics/machines: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing machine analytics.' });
  }
});

// ── GET /analytics/constraint ───────────────────────────────────────────────
//
// CONSTRAINT SCORE (heuristic — documented per spec):
//
//   score = utilization × inputBufferFullness × downstreamStarvation
//
//   • utilization         = utilizationPct / 100            (machine is busy)
//   • inputBufferFullness = inputBufferPct / 100            (work piling up IN
//                            FRONT of it; null/no-buffer → 0, so a machine with
//                            no buffer telemetry can't score as a constraint)
//   • downstreamStarvation = 1 − avg(input-buffer pct of every OTHER machine)/100
//
// downstreamStarvation is a deliberate SHOP-WIDE PROXY for true routing
// topology. Resolving each machine's actual downstream neighbours means walking
// the operation-flow graph per task — out of scope for this read-only analytics
// layer. Instead we reason: if the REST of the shop's input buffers sit empty
// (starved) while this machine's input buffer is full and it's highly utilized,
// this machine is the most likely bottleneck starving everything downstream.
// All three factors live in [0,1], so the score is a 0..1 number; higher = more
// constraint-like. When there are no other machines with buffer data,
// downstreamStarvation is 0 (a single machine can't starve anything).

router.get('/analytics/constraint', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'analytics/constraint');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const range = parseRange(req.query);
    const machines = await buildMachineRows(companyId, range);

    // Shop-wide input-buffer pool for the downstream-starvation proxy.
    const withBuffer = machines.filter((m) => m.inputBufferPct != null);
    const sumPct = withBuffer.reduce((s, m) => s + m.inputBufferPct, 0);
    const cnt = withBuffer.length;

    const ranked = machines
      .map((m) => {
        const u = clamp01(m.utilizationPct / 100);
        const f = m.inputBufferPct != null ? clamp01(m.inputBufferPct / 100) : 0;

        // avg of OTHER machines' input-buffer pct (exclude self)
        const selfPct = m.inputBufferPct ?? 0;
        const otherCnt = cnt - (m.inputBufferPct != null ? 1 : 0);
        const otherAvgPct = otherCnt > 0 ? (sumPct - selfPct) / otherCnt : 0;
        const downstreamStarvation = cnt > 0 ? clamp01(1 - otherAvgPct / 100) : 0;

        const score = round(u * f * downstreamStarvation, 4);
        const reason =
          `${round(m.utilizationPct)}% utilized with a ` +
          `${m.inputBufferPct != null ? `${round(m.inputBufferPct)}% full input buffer` : 'no input-buffer telemetry'}` +
          `, while other machines sit ${round(downstreamStarvation * 100)}% starved.`;

        return {
          resourceId: m.resourceId,
          name: m.name,
          score,
          utilizationPct: m.utilizationPct,
          inputBufferPct: m.inputBufferPct,
          downstreamStarvationPct: round(downstreamStarvation * 100, 1),
          reason,
        };
      })
      .sort((a, b) => b.score - a.score);

    const constraint = ranked.length > 0 ? {
      resourceId: ranked[0].resourceId,
      name: ranked[0].name,
      score: ranked[0].score,
      reason: ranked[0].reason,
    } : null;

    return res.status(200).json({ ok: true, from: range.fromIso, to: range.toIso, constraint, ranked });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp analytics/constraint: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing constraint.' });
  }
});

// ── GET /analytics/wait-pareto ──────────────────────────────────────────────
// Total wait working-minutes by reason across all tasks (or one order's tasks
// when ?orderId= is given), descending. Segments are date-filtered by seg_start.

router.get('/analytics/wait-pareto', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'analytics/wait-pareto');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const orderId = req.query.orderId != null && req.query.orderId !== ''
    ? Number(req.query.orderId)
    : null;
  if (req.query.orderId != null && req.query.orderId !== '' &&
      (!Number.isFinite(orderId) || orderId <= 0)) {
    return res.status(400).json({ message: 'orderId must be a positive integer.' });
  }

  try {
    const range = parseRange(req.query);

    let sql =
      `SELECT s.reason AS reason, SUM(s.working_minutes) AS minutes
         FROM fab_task_wait_segments s`;
    if (orderId != null) {
      sql += `
         JOIN fab_project_tasks t ON t.id = s.task_id AND t.company_id = s.company_id
             AND t.order_id = ? AND t.deleted_at IS NULL`;
    }
    sql += `
        WHERE s.company_id = ? AND s.deleted_at IS NULL
          AND s.seg_start >= ? AND s.seg_start <= ?
        GROUP BY s.reason
        ORDER BY minutes DESC`;

    // param order must match the ? positions above (the order-filter ? comes first)
    const finalParams = orderId != null
      ? [orderId, companyId, range.fromSql, range.toSql]
      : [companyId, range.fromSql, range.toSql];

    const [rows] = await pool.query(sql, finalParams);

    const byReason = rows
      .map((r) => ({ reason: r.reason, minutes: round(Number(r.minutes)) }))
      .filter((r) => r.minutes > 0);
    const totalMinutes = byReason.reduce((s, r) => s + r.minutes, 0);

    return res.status(200).json({
      ok: true,
      from: range.fromIso,
      to: range.toIso,
      orderId: orderId ?? null,
      byReason,
      totalMinutes,
    });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp analytics/wait-pareto: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing wait Pareto.' });
  }
});

// ── GET /analytics/project/:orderId ─────────────────────────────────────────
// Per-item and order-level touch-time vs wait-time.
//   • touchMinutes = active work time from fab_task_events: sum of intervals
//     from a 'started'/'resumed' event to the next event (paused/completed/
//     cancelled or window end for a still-open interval), clipped to [from,to].
//   • waitMinutes  = SUM(fab_task_wait_segments.working_minutes), seg_start in range.
//   • ratio        = touch / wait, or null when there is no wait time.

router.get('/analytics/project/:orderId', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user)) return denyPermission(res, user, 'analytics/project');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  const orderId = Number(req.params.orderId);
  if (!req.params.orderId || !Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'orderId must be a positive integer.' });
  }

  try {
    const range = parseRange(req.query);

    const [orderRows] = await pool.query(
      `SELECT id, order_number AS orderNumber FROM fab_orders
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [orderId, companyId],
    );
    if (orderRows.length === 0) {
      return res.status(404).json({ message: `Order with id ${orderId} not found.` });
    }

    // touch-time per item (walk task events, clip to range) — set-based, no N+1
    const [touchRows] = await pool.query(
      `WITH ev AS (
         SELECT t.item_id AS item_id, te.event_type AS event_type, te.at AS at,
                LEAD(te.at) OVER (PARTITION BY te.task_id ORDER BY te.at, te.id) AS next_at
           FROM fab_task_events te
           JOIN fab_project_tasks t ON t.id = te.task_id AND t.company_id = te.company_id
          WHERE te.company_id = ? AND te.deleted_at IS NULL AND te.superseded_by_event_id IS NULL
            AND t.order_id = ? AND t.deleted_at IS NULL
            AND te.event_type IN ('started','resumed','paused','completed','cancelled')
       )
       SELECT item_id AS itemId,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND,
                    GREATEST(at, ?),
                    LEAST(COALESCE(next_at, ?), ?)))) AS touchSeconds
         FROM ev
        WHERE event_type IN ('started','resumed')
        GROUP BY item_id`,
      [companyId, orderId, range.fromSql, range.effectiveToSql, range.effectiveToSql],
    );

    // wait-time per item
    const [waitRows] = await pool.query(
      `SELECT t.item_id AS itemId, SUM(s.working_minutes) AS waitMinutes
         FROM fab_task_wait_segments s
         JOIN fab_project_tasks t ON t.id = s.task_id AND t.company_id = s.company_id
        WHERE s.company_id = ? AND s.deleted_at IS NULL
          AND t.order_id = ? AND t.deleted_at IS NULL
          AND s.seg_start >= ? AND s.seg_start <= ?
        GROUP BY t.item_id`,
      [companyId, orderId, range.fromSql, range.toSql],
    );

    // item names for this order
    const [itemRows] = await pool.query(
      `SELECT id, name FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId],
    );

    const touchByItem = new Map(touchRows.map((r) => [r.itemId, round(Number(r.touchSeconds) / 60)]));
    const waitByItem = new Map(waitRows.map((r) => [r.itemId, round(Number(r.waitMinutes))]));
    const nameByItem = new Map(itemRows.map((r) => [r.id, r.name]));

    const itemIds = new Set([
      ...touchByItem.keys(),
      ...waitByItem.keys(),
      ...nameByItem.keys(),
    ]);

    const items = [...itemIds]
      .map((itemId) => {
        const touchMinutes = touchByItem.get(itemId) ?? 0;
        const waitMinutes = waitByItem.get(itemId) ?? 0;
        return {
          itemId,
          name: nameByItem.get(itemId) ?? `Item #${itemId}`,
          touchMinutes,
          waitMinutes,
          ratio: waitMinutes > 0 ? round(touchMinutes / waitMinutes, 2) : null,
        };
      })
      // Drop items with no activity at all in-range to keep the payload tight.
      .filter((it) => it.touchMinutes > 0 || it.waitMinutes > 0)
      .sort((a, b) => (b.touchMinutes + b.waitMinutes) - (a.touchMinutes + a.waitMinutes));

    const orderTouch = items.reduce((s, it) => s + it.touchMinutes, 0);
    const orderWait = items.reduce((s, it) => s + it.waitMinutes, 0);

    return res.status(200).json({
      ok: true,
      from: range.fromIso,
      to: range.toIso,
      order: {
        orderId,
        orderNumber: orderRows[0].orderNumber,
        touchMinutes: orderTouch,
        waitMinutes: orderWait,
        ratio: orderWait > 0 ? round(orderTouch / orderWait, 2) : null,
      },
      items,
    });
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp analytics/project: unexpected error');
    return res.status(500).json({ message: 'Internal server error computing project analytics.' });
  }
});

export default router;
