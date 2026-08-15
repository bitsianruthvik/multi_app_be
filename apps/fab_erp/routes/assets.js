/**
 * assets.js — the machine as an ASSET: what it cost, what it is worth, when it
 * was last looked after, and what has been bought for it.
 *
 *   GET    /assets/maintenance                     due list across the shop
 *   GET    /assets/resources/:id/maintenance       one machine's plans + history
 *   POST   /assets/maintenance/plans               create / update a plan
 *   DELETE /assets/maintenance/plans/:planId
 *   POST   /assets/resources/:id/maintenance/start begin, and take it out of service
 *   POST   /assets/resources/:id/maintenance/stop  finish, roll the plan forward
 *   GET    /assets/resources/:id/valuation         computed depreciation
 *   POST   /assets/purchase                        raise a spares / new-machine PO
 *   GET    /assets/purchases                       POs raised for a machine or type
 *
 * Permission: `fab_erp_resources_manage` for anything that writes, since these
 * are all facts about the machine catalog. Reading the due list is allowed to
 * anyone who can see machines — a supervisor needs to know what is due without
 * being able to edit the asset register.
 */

import { Router } from 'express';
import { pool } from '../../../db.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import {
  maintenanceOverview, savePlan, deletePlan, startMaintenance, stopMaintenance,
  maintenanceHistory,
} from '../services/maintenanceService.js';
import { depreciationFor } from '../services/assetService.js';
import { raiseAssetPurchase, assetPurchases } from '../services/assetPurchaseService.js';

const router = Router();

const companyOf = (req) => req.user.companyId ?? req.user.company_id;

const requirePerm = (tag) => (req, res, next) => {
  if (String(req.user?.role ?? '').toLowerCase() === 'admin') return next();
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};
const canManage = requirePerm('fab_erp_resources_manage');
const canView = requirePerm('fab_erp_resources_view');

/** Turn a thrown error into the status it asked for, else 500. */
const fail = (res, err, what) => {
  if (err?.status) return res.status(err.status).json({ message: err.message });
  logger.error({ err }, `fab_erp assets: ${what} failed`);
  return res.status(500).json({ message: err?.message ?? 'Something went wrong.' });
};

// ── Maintenance ─────────────────────────────────────────────────────────────

router.get('/assets/maintenance', protect, canView, async (req, res) => {
  try {
    res.json(await maintenanceOverview(companyOf(req)));
  } catch (err) { fail(res, err, 'maintenance overview'); }
});

router.get('/assets/resources/:id/maintenance', protect, canView, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const resourceId = Number(req.params.id);
    const [overview, history] = await Promise.all([
      maintenanceOverview(companyId, { resourceId }),
      maintenanceHistory(companyId, resourceId),
    ]);
    res.json({ ...overview, history });
  } catch (err) { fail(res, err, 'machine maintenance'); }
});

router.post('/assets/maintenance/plans', protect, canManage, async (req, res) => {
  try {
    res.json(await savePlan(companyOf(req), req.body ?? {}));
  } catch (err) { fail(res, err, 'save plan'); }
});

router.delete('/assets/maintenance/plans/:planId', protect, canManage, async (req, res) => {
  try {
    await deletePlan(companyOf(req), Number(req.params.planId));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'delete plan'); }
});

/**
 * Start maintenance. The machine goes 'down', which stops a task being STARTED
 * on it (`/tasks/:id/start` returns 409 MACHINE_DOWN) and drops it from
 * dispatch. NOTE: the resource leveller does not read machine state, so already
 * planned work is not re-planned away from it — see the route docs in
 * resourceLevelingService and §13.
 */
router.post('/assets/resources/:id/maintenance/start', protect, canManage, async (req, res) => {
  try {
    const out = await startMaintenance(
      companyOf(req),
      { resourceId: Number(req.params.id), planId: req.body?.planId ?? null, note: req.body?.note ?? null },
      req.user.id,
    );
    res.json({ ok: true, ...out });
  } catch (err) { fail(res, err, 'start maintenance'); }
});

router.post('/assets/resources/:id/maintenance/stop', protect, canManage, async (req, res) => {
  try {
    const out = await stopMaintenance(
      companyOf(req),
      { resourceId: Number(req.params.id), note: req.body?.note ?? null },
      req.user.id,
    );
    res.json({ ok: true, ...out });
  } catch (err) { fail(res, err, 'stop maintenance'); }
});

// ── Valuation ───────────────────────────────────────────────────────────────

router.get('/assets/resources/:id/valuation', protect, canView, async (req, res) => {
  try {
    const [[r]] = await pool.query(
      `SELECT id, name, code, currency, purchase_date, commissioned_date, asset_cost,
              salvage_value, useful_life_years, depreciation_method, depreciation_rate_pct
         FROM fab_resources
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [Number(req.params.id), companyOf(req)],
    );
    if (!r) return res.status(404).json({ message: 'Machine not found.' });
    res.json({ resourceId: r.id, name: r.name, currency: r.currency ?? null, ...depreciationFor(r) });
  } catch (err) { fail(res, err, 'valuation'); }
});

// ── Purchases for a machine / machine type ──────────────────────────────────

router.post('/assets/purchase', protect, canManage, async (req, res) => {
  try {
    res.json({ ok: true, order: await raiseAssetPurchase(companyOf(req), req.body ?? {}, req.user.id) });
  } catch (err) { fail(res, err, 'raise asset purchase'); }
});

router.get('/assets/purchases', protect, canView, async (req, res) => {
  try {
    res.json({
      orders: await assetPurchases(companyOf(req), {
        resourceId: req.query.resourceId ? Number(req.query.resourceId) : null,
        resourceTypeId: req.query.resourceTypeId ? Number(req.query.resourceTypeId) : null,
      }),
    });
  } catch (err) { fail(res, err, 'asset purchases'); }
});

export default router;
