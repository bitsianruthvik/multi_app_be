/**
 * scheduler.js — Scheduler routes
 *
 * POST /scheduler/run           — manual trigger (fab_erp_scheduler_manage)
 * GET  /scheduler/entries       — schedule entries, filterable
 * PUT  /scheduler/entries/:id/lock — lock/unlock an entry
 * GET  /scheduler/runs          — run history
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import {
  runScheduler,
  getScheduleEntries,
  lockEntry,
  getSchedulerRuns,
} from '../services/schedulerService.js';

const router = Router();

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

// ── POST /scheduler/run ───────────────────────────────────────────────────────
router.post(
  '/scheduler/run',
  protect, requirePerm('fab_erp_scheduler_manage'),
  async (req, res) => {
    const companyId = req.user.companyId ?? req.user.company_id;
    try {
      const result = await runScheduler(companyId, {
        triggeredBy: 'manual',
        userId: req.user.id,
      });
      return res.json(result);
    } catch (err) {
      logger.error({ err }, '[scheduler route] run failed');
      return res.status(500).json({ message: 'Scheduler run failed', error: err.message });
    }
  },
);

// ── GET /scheduler/entries ────────────────────────────────────────────────────
router.get(
  '/scheduler/entries',
  protect, requirePerm('fab_erp_scheduler_view'),
  async (req, res) => {
    const companyId = req.user.companyId ?? req.user.company_id;
    const { from, to, resource_id, order_id } = req.query;
    try {
      const rows = await getScheduleEntries(companyId, {
        fromDate:   from   || null,
        toDate:     to     || null,
        resourceId: resource_id ? Number(resource_id) : null,
        orderId:    order_id    ? Number(order_id)    : null,
      });
      return res.json(rows);
    } catch (err) {
      logger.error({ err }, '[scheduler route] entries failed');
      return res.status(500).json({ message: 'Failed to fetch schedule entries' });
    }
  },
);

// ── PUT /scheduler/entries/:id/lock ──────────────────────────────────────────
router.put(
  '/scheduler/entries/:id/lock',
  protect, requirePerm('fab_erp_scheduler_manage'),
  async (req, res) => {
    const companyId = req.user.companyId ?? req.user.company_id;
    const entryId   = Number(req.params.id);
    const { locked } = req.body;
    if (typeof locked !== 'boolean') {
      return res.status(400).json({ message: '"locked" must be a boolean' });
    }
    try {
      await lockEntry(entryId, companyId, locked);
      return res.json({ ok: true, entryId, locked });
    } catch (err) {
      logger.error({ err }, '[scheduler route] lock failed');
      return res.status(500).json({ message: 'Failed to update lock' });
    }
  },
);

// ── GET /scheduler/runs ───────────────────────────────────────────────────────
router.get(
  '/scheduler/runs',
  protect, requirePerm('fab_erp_scheduler_view'),
  async (req, res) => {
    const companyId = req.user.companyId ?? req.user.company_id;
    try {
      const rows = await getSchedulerRuns(companyId);
      return res.json(rows);
    } catch (err) {
      logger.error({ err }, '[scheduler route] runs failed');
      return res.status(500).json({ message: 'Failed to fetch scheduler runs' });
    }
  },
);

export default router;
