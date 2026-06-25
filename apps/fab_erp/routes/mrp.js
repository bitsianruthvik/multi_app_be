/**
 * routes/mrp.js
 * -------------
 * MRP (Material Requirements Planning) routes for fab_erp.
 *
 * Mounted under /api/:companySlug/fab_erp
 *
 * Routes:
 *   POST /mrp/run       — trigger an MRP run manually
 *   GET  /mrp/runs      — fetch the last 20 run log entries
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger  } from '../../../core/utils/logger.js';
import { runMrp, getMrpRuns, getMrpSettings, saveMrpSettings } from '../services/mrpService.js';

const router = Router();

const requirePerm = (tag) => (req, res, next) => {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin && (!Array.isArray(user?.uiPermissions) || !user.uiPermissions.includes(tag))) {
    return res.status(403).json({ message: `Permission denied. Required: "${tag}".` });
  }
  next();
};

// ── POST /mrp/run ─────────────────────────────────────────────────────────────
router.post('/mrp/run', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  const user = req.user;
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId.' });

  try {
    const result = await runMrp(companyId, { triggeredBy: 'manual', userId: user.id });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp mrp/run: unexpected error');
    return res.status(500).json({ message: err.message || 'MRP run failed.' });
  }
});

// ── GET /mrp/runs ─────────────────────────────────────────────────────────────
router.get('/mrp/runs', protect, requirePerm('fab_erp_planning_view'), async (req, res) => {
  const user = req.user;
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId.' });

  try {
    const rows = await getMrpRuns(companyId, 20);
    return res.status(200).json({ ok: true, data: rows });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp mrp/runs: unexpected error');
    return res.status(500).json({ message: 'Failed to fetch MRP run history.' });
  }
});

// ── GET /mrp/settings ────────────────────────────────────────────────────────
router.get('/mrp/settings', protect, requirePerm('fab_erp_planning_view'), async (req, res) => {
  const companyId = req.user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId.' });
  try {
    const settings = await getMrpSettings(companyId);
    return res.status(200).json({ ok: true, data: settings });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch MRP settings.' });
  }
});

// ── PUT /mrp/settings ────────────────────────────────────────────────────────
router.put('/mrp/settings', protect, async (req, res) => {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    const tag = 'fab_erp_projects_manage';
    if (!Array.isArray(user?.uiPermissions) || !user.uiPermissions.includes(tag)) {
      return res.status(403).json({ message: `Permission denied. Required: "${tag}".` });
    }
  }
  const companyId = user.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId.' });

  const { autoRunEnabled, runHour, runMinute } = req.body ?? {};
  const h = Number(runHour);
  const m = Number(runMinute);
  if (isNaN(h) || h < 0 || h > 23) return res.status(400).json({ message: 'runHour must be 0–23.' });
  if (isNaN(m) || m < 0 || m > 59) return res.status(400).json({ message: 'runMinute must be 0–59.' });

  try {
    await saveMrpSettings(companyId, { autoRunEnabled: !!autoRunEnabled, runHour: h, runMinute: m });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to save MRP settings.' });
  }
});

export default router;
