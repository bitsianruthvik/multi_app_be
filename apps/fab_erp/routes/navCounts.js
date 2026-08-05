/**
 * navCounts.js — badge counts for the fab_erp two-row top navigation
 *
 * GET /nav-counts
 *
 * The contextual nav row shows a live count beside each screen ("Queue · 34
 * open", "Reconcile · 3 gaps") so navigation doubles as a status surface. That
 * needs one cheap round trip, not one per screen.
 *
 * Why a dedicated endpoint rather than the generic query API: that API returns
 * `total: rows.length` (see core/query/queryController.js), i.e. the size of
 * the page it just returned — not a true COUNT. Counting through it would mean
 * fetching every row of eight tables on every section change.
 *
 * Contract: always 200 with a `counts` object. A failed sub-query yields a
 * missing key, and the frontend renders no badge for it. Navigation must never
 * depend on a count succeeding.
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

/** Statuses that mean the order is live on the shop floor. */
const ACTIVE_ORDER_STATUSES = [
  'in_production', 'scheduled', 'scheduled_late', 'released',
];

router.get('/nav-counts', protect, async (req, res) => {
  const companyId = req.user.companyId ?? req.user.company_id;

  // Each entry is [key, sql, params]. They run concurrently and independently
  // so one bad query can't take the whole nav bar down with it.
  const closedList = CLOSED_ORDER_STATUSES.map(() => '?').join(',');
  const activeList = ACTIVE_ORDER_STATUSES.map(() => '?').join(',');

  const queries = [
    ['openOrders',
      `SELECT COUNT(*) AS n FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND status NOT IN (${closedList})`,
      [companyId, ...CLOSED_ORDER_STATUSES]],

    ['activeOrders',
      `SELECT COUNT(*) AS n FROM fab_orders
       WHERE company_id=? AND deleted_at IS NULL AND status IN (${activeList})`,
      [companyId, ...ACTIVE_ORDER_STATUSES]],

    // "Open" work = anything not finished. Operators care about the whole
    // backlog, not just what is runnable this second.
    ['openTasks',
      `SELECT COUNT(*) AS n FROM fab_project_tasks
       WHERE company_id=? AND deleted_at IS NULL AND status <> 'done'`,
      [companyId]],

    // A machine is running if work is in progress on it. fab_machines has no
    // state column — the task table is the source of truth for liveness.
    ['machinesRunning',
      `SELECT COUNT(DISTINCT assigned_resource_id) AS n FROM fab_project_tasks
       WHERE company_id=? AND deleted_at IS NULL AND status='in_progress'
         AND assigned_resource_id IS NOT NULL`,
      [companyId]],

    // Buffers past their action threshold — the CCPM "red zone". Scoped to
    // live plans: a superseded or archived plan's buffers are history, and
    // counting them made the badge permanently red once a project replanned.
    // act_pct is NOT NULL DEFAULT 67, so the old COALESCE was dead.
    ['redBuffers',
      `SELECT COUNT(*) AS n FROM fab_cc_buffers b
       JOIN fab_cc_plans p ON p.id = b.plan_id AND p.deleted_at IS NULL
         AND p.status IN ('draft','baselined')
       WHERE b.company_id=? AND b.deleted_at IS NULL AND b.size_minutes > 0
         AND (b.consumed_minutes / b.size_minutes) * 100 >= b.act_pct`,
      [companyId]],

    ['items',
      `SELECT COUNT(*) AS n FROM fab_item_catalog
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],

    // Counts the per-project BOMs that are actually built and used. This used to
    // count fab_bom_templates, which held zero rows for the life of the feature,
    // so the badge always read 0 next to a screen nobody had ever filled in.
    ['boms',
      `SELECT COUNT(*) AS n FROM fab_material_boms
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],

    ['operations',
      `SELECT COUNT(*) AS n FROM fab_operations
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],

    ['flows',
      `SELECT COUNT(*) AS n FROM fab_operation_flows
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],

    ['machines',
      `SELECT COUNT(*) AS n FROM fab_resources
       WHERE company_id=? AND deleted_at IS NULL`,
      [companyId]],
  ];

  const settled = await Promise.allSettled(
    queries.map(([, sql, params]) => pool.query(sql, params)),
  );

  const counts = {};
  settled.forEach((result, i) => {
    const key = queries[i][0];
    if (result.status === 'fulfilled') {
      counts[key] = Number(result.value[0]?.[0]?.n ?? 0);
    } else {
      // Log, omit the key, carry on — a missing badge is invisible to the user.
      logger?.warn?.(`nav-counts: ${key} failed — ${result.reason?.message}`);
    }
  });

  res.json({ counts });
});

export default router;
