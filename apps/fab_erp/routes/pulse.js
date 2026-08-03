/**
 * pulse.js — data for the Factory Pulse cockpit (`/home`)
 *
 * GET /pulse
 *
 * The cockpit answers one question: "what needs me today?" That needs both
 * headline numbers and a *prioritised list of specific problems* — a count of
 * overdue orders is useless without knowing which ones.
 *
 * One round trip on purpose. The cockpit is the landing page for every role, so
 * firing eight queries from the client would make the slowest screen in the app
 * the first one everybody sees.
 *
 * Contract mirrors /nav-counts: always 200 with `{ kpis, exceptions }`. Every
 * sub-query runs under Promise.allSettled and a failure omits its key / yields
 * an empty group rather than failing the response. A cockpit that 500s because
 * one aggregate is unhappy is worse than a cockpit missing one card.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const router = Router();

/** Order statuses that mean "no longer needs attention". */
const CLOSED_ORDER_STATUSES = [
  'completed', 'cancelled', 'closed', 'shipped', 'received', 'converted',
];

/** How many rows each exception group returns. The feed is a to-do list, not a report. */
const EXCEPTION_LIMIT = 5;

router.get('/pulse', protect, async (req, res) => {
  const companyId = req.user.companyId ?? req.user.company_id;
  const closedList = CLOSED_ORDER_STATUSES.map(() => '?').join(',');

  // ── KPI aggregates ──────────────────────────────────────────────────────
  const kpiQueries = [
    ['openOrders',
      `SELECT COUNT(*) AS n FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND status NOT IN (${closedList})`,
      [companyId, ...CLOSED_ORDER_STATUSES]],

    ['overdueOrders',
      `SELECT COUNT(*) AS n FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND status NOT IN (${closedList})
         AND required_date IS NOT NULL AND required_date < CURDATE()`,
      [companyId, ...CLOSED_ORDER_STATUSES]],

    ['tasksInProgress',
      `SELECT COUNT(*) AS n FROM fab_project_tasks
       WHERE company_id=? AND deleted_at IS NULL AND status='in_progress'`,
      [companyId]],

    ['tasksBlocked',
      `SELECT COUNT(*) AS n FROM fab_project_tasks
       WHERE company_id=? AND deleted_at IS NULL AND status='blocked'`,
      [companyId]],

    ['tasksEligible',
      `SELECT COUNT(*) AS n FROM fab_project_tasks
       WHERE company_id=? AND deleted_at IS NULL AND status='eligible'`,
      [companyId]],

    // A machine counts as running if work is in progress on it — fab_resources
    // has no state column, the task table is the source of truth for liveness.
    ['machinesRunning',
      `SELECT COUNT(DISTINCT assigned_resource_id) AS n FROM fab_project_tasks
       WHERE company_id=? AND deleted_at IS NULL AND status='in_progress'
         AND assigned_resource_id IS NOT NULL`,
      [companyId]],

    ['machinesTotal',
      `SELECT COUNT(*) AS n FROM fab_resources
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],

    ['redBuffers',
      `SELECT COUNT(*) AS n FROM fab_cc_buffers b
       JOIN fab_cc_plans p ON p.id = b.plan_id AND p.deleted_at IS NULL
         AND p.status IN ('draft','baselined')
       WHERE b.company_id=? AND b.deleted_at IS NULL AND b.size_minutes > 0
         AND (b.consumed_minutes / b.size_minutes) * 100 >= b.act_pct`,
      [companyId]],

    // Work-queue counts. These live here rather than being derived client-side
    // because the generic query API's `total` is the size of the page it just
    // returned, not a COUNT — fetching 500 rows to count them is both wrong at
    // the boundary and wasteful (see ARCHITECTURE §6 /nav-counts note).
    ['draftSalesOrders',
      `SELECT COUNT(*) AS n FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND order_type='sales' AND status='draft'`,
      [companyId]],

    ['posInTransit',
      `SELECT COUNT(*) AS n FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND order_type='purchase' AND status='sent'`,
      [companyId]],

    ['items',
      `SELECT COUNT(*) AS n FROM fab_item_catalog
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],
  ];

  // ── Exception feed — each row must be actionable and link somewhere ──────
  const exceptionQueries = [
    ['overdueOrders',
      `SELECT id, order_number AS orderNumber, status, required_date AS requiredDate,
              DATEDIFF(CURDATE(), required_date) AS daysLate
       FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND status NOT IN (${closedList})
         AND required_date IS NOT NULL AND required_date < CURDATE()
       ORDER BY required_date ASC LIMIT ${EXCEPTION_LIMIT}`,
      [companyId, ...CLOSED_ORDER_STATUSES]],

    // Blocked work grouped by order — an operator cares "which job is stuck",
    // not "which of 300 task rows".
    ['blockedWork',
      `SELECT o.id AS orderId, o.order_number AS orderNumber, COUNT(*) AS blockedCount
       FROM fab_project_tasks t
       JOIN fab_orders o ON o.id = t.order_id AND o.deleted_at IS NULL
       WHERE t.company_id=? AND t.deleted_at IS NULL AND t.status='blocked'
       GROUP BY o.id, o.order_number
       ORDER BY blockedCount DESC LIMIT ${EXCEPTION_LIMIT}`,
      [companyId]],

    // FEAT-09: a flow step whose operation has no time formula produces a
    // zero-duration task, which silently corrupts every schedule built on it.
    ['flowsMissingFormula',
      `SELECT DISTINCT f.id, f.code, f.name
       FROM fab_operation_flows f
       JOIN fab_operation_flow_steps s ON s.flow_id = f.id AND s.deleted_at IS NULL
       JOIN fab_operations op ON op.id = s.operation_id AND op.deleted_at IS NULL
       WHERE f.company_id=? AND f.deleted_at IS NULL
         AND (op.time_formula IS NULL OR TRIM(op.time_formula) = '')
       LIMIT ${EXCEPTION_LIMIT}`,
      [companyId]],

    // fab_cc_buffers has no order_id — it hangs off a plan (fab_cc_plans),
    // which is what carries the order. Join through the plan, and only count
    // buffers on plans that are still live (a superseded/archived plan's
    // buffers are history, not a problem to act on).
    ['redBuffers',
      `SELECT b.id, b.kind, p.order_id AS orderId, o.order_number AS orderNumber,
              ROUND((b.consumed_minutes / b.size_minutes) * 100) AS consumedPct
       FROM fab_cc_buffers b
       JOIN fab_cc_plans p ON p.id = b.plan_id AND p.deleted_at IS NULL
         AND p.status IN ('draft','baselined')
       LEFT JOIN fab_orders o ON o.id = p.order_id AND o.deleted_at IS NULL
       WHERE b.company_id=? AND b.deleted_at IS NULL AND b.size_minutes > 0
         AND (b.consumed_minutes / b.size_minutes) * 100 >= b.act_pct
       ORDER BY consumedPct DESC LIMIT ${EXCEPTION_LIMIT}`,
      [companyId]],
  ];

  const all = [...kpiQueries, ...exceptionQueries];
  const settled = await Promise.allSettled(
    all.map(([, sql, params]) => pool.query(sql, params)),
  );

  const kpis = {};
  const exceptions = {};

  settled.forEach((result, i) => {
    const key = all[i][0];
    const isKpi = i < kpiQueries.length;
    if (result.status !== 'fulfilled') {
      // Log, omit, carry on — a missing card is invisible; a 500 is not.
      logger?.warn?.(`pulse: ${isKpi ? 'kpi' : 'exception'} ${key} failed — ${result.reason?.message}`);
      if (!isKpi) exceptions[key] = [];
      return;
    }
    const rows = result.value[0] ?? [];
    if (isKpi) kpis[key] = Number(rows[0]?.n ?? 0);
    else exceptions[key] = rows;
  });

  res.json({ kpis, exceptions });
});

export default router;
