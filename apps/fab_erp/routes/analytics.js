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
 * Input-buffer fullness pct per machine. Returns Map<resourceId, pct(number)>.
 *
 * Derived live from the WIP pieces standing at each machine's stock area — the
 * same aggregate /buffers/board renders, so the two screens can never disagree.
 *
 * This used to read the newest fab_buffer_level_snapshots row at/before the
 * window end. That table had a single writer (placeOutput, removed 2026-08-05
 * with fab_buffer_contents) and zero rows in every environment, so the column
 * has been blank since it shipped.
 *
 * Consequence of deriving: the pct is how full the machine is NOW, not as of a
 * past window end. Buffer fullness is a right-now question — the other columns
 * on this row are genuinely windowed, this one is not. Everything else on the
 * page respects the range.
 */
async function fetchInputBufferPct(companyId) {
  const [rows] = await pool.query(
    `SELECT b.resource_id                    AS resourceId,
            b.capacity_value                 AS capacity,
            SUM(p.qty * v.metric_value)      AS weightSum
       FROM fab_buffers b
       LEFT JOIN fab_stock_locations l
         ON l.company_id = b.company_id AND l.deleted_at IS NULL
        AND (l.id = b.stock_location_id
             OR (b.stock_location_id IS NULL
                 AND l.code = CONCAT('WIP-M', b.resource_id)))
       LEFT JOIN fab_stock_pieces p
              ON p.company_id = b.company_id AND p.stock_location_id = l.id
             AND p.status = 'wip' AND p.deleted_at IS NULL
       LEFT JOIN fab_item_metric_values v
              ON v.item_id = p.wip_item_id AND v.company_id = p.company_id
             AND v.metric_key = COALESCE(b.weight_metric_key, 'unit_weight_kg')
             AND v.deleted_at IS NULL
      WHERE b.company_id = ? AND b.kind = 'input' AND b.active = 1
        AND b.deleted_at IS NULL AND b.capacity_value > 0
      GROUP BY b.id, b.resource_id, b.capacity_value`,
    [companyId],
  );

  const byResource = new Map();
  for (const r of rows) {
    const load = Number(r.weightSum ?? 0);
    byResource.set(r.resourceId, round((load / Number(r.capacity)) * 100, 2));
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
    fetchInputBufferPct(companyId),
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

export default router;
