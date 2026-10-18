import { Router } from 'express';
import { pool } from '../../../db.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import * as reports from '../services/reportService.js';
import { insights } from '../services/insightService.js';

/**
 * The screens' side: a platform login with access to this app (protect checks
 * app_user_access). Every figure comes from the rows the connector pushed —
 * no screen ever talks to SAP. Most reports take ?unit= (a business place,
 * e.g. "Unit 2") and ?from=&to= (YYYY-MM-DD).
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
const cid = (req) => req.company.id;

router.get('/status', protect, wrap((req) => reports.status(cid(req))));
router.get('/units', protect, wrap((req) => reports.units(cid(req))));
router.get('/insights', protect, wrap((req) => insights(cid(req), req.query)));
router.get('/overview', protect, wrap((req) => reports.overview(cid(req), req.query)));
router.get('/sales', protect, wrap((req) => reports.sales(cid(req), req.query)));
router.get('/sales/customer/:cardCode', protect, wrap((req) => reports.salesCustomer(cid(req), req.params.cardCode, req.query)));
router.get('/sales-orders', protect, wrap((req) => reports.salesOrders(cid(req), req.query)));
router.get('/dispatch', protect, wrap((req) => reports.dispatch(cid(req), req.query)));
router.get('/receivables', protect, wrap((req) => reports.receivables(cid(req), req.query)));
router.get('/payables', protect, wrap((req) => reports.payables(cid(req), req.query)));
router.get('/purchase', protect, wrap((req) => reports.purchase(cid(req), req.query)));
router.get('/purchase-orders', protect, wrap((req) => reports.purchaseOrders(cid(req), req.query)));
router.get('/production', protect, wrap((req) => reports.production(cid(req), req.query)));
router.get('/inventory', protect, wrap((req) => reports.inventory(cid(req), req.query)));
router.get('/inventory/item/:itemCode', protect, wrap((req) => reports.inventoryItem(cid(req), req.params.itemCode)));
router.get('/saved-reports', protect, wrap((req) => reports.savedReports(cid(req))));

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
