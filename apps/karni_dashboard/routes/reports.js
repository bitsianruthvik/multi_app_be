import { Router } from 'express';
import { pool } from '../../../db.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import * as reports from '../services/reportService.js';

/**
 * The screens' side: a platform login with access to this app (protect checks
 * app_user_access). Every figure comes from the rows the connector pushed —
 * no screen ever talks to SAP.
 */
const router = Router({ mergeParams: true });

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    req.log?.error?.({ err }, 'karni_dashboard');
    res.status(500).json({ error: err.message });
  }
};

const isAdmin = (req) => String(req.user?.role || '').toLowerCase() === 'admin';

router.get('/status', protect, wrap((req) => reports.status(req.company.id)));
router.get('/overview', protect, wrap((req) => reports.overview(req.company.id)));
router.get('/sales', protect, wrap((req) => reports.sales(req.company.id, req.query)));
router.get('/receivables', protect, wrap((req) => reports.receivables(req.company.id)));
router.get('/payables', protect, wrap((req) => reports.payables(req.company.id)));
router.get('/sales-orders', protect, wrap((req) => reports.salesOrders(req.company.id)));
router.get('/purchase-orders', protect, wrap((req) => reports.purchaseOrders(req.company.id)));
router.get('/inventory', protect, wrap((req) => reports.inventory(req.company.id)));
router.get('/saved-reports', protect, wrap((req) => reports.savedReports(req.company.id)));

/** Approve or revoke a connector — the company's admins only. */
for (const [action, status] of [['approve', 'approved'], ['revoke', 'revoked']]) {
  router.post(`/connectors/:id/${action}`, protect, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can do this.' });
    const [r] = await pool.query(
      `UPDATE kd_connectors SET status = ?, approved_by = ?, approved_at = IF(? = 'approved', NOW(), approved_at)
        WHERE id = ? AND company_id = ?`,
      [status, req.user.id, status, Number(req.params.id), req.company.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'No such connector.' });
    res.json({ ok: true, status });
  });
}

export default router;
