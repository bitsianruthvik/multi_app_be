import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import * as reports from '../services/reportService.js';

/**
 * The screens' side: a platform login with access to this app (protect checks
 * app_user_access). Reports take the same filters: ?from=&to=&finish=&metal=
 * &weight=&size=&market=&repeat=&tests=&customer=
 */
const router = Router({ mergeParams: true });

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (!err.status) req.log?.error?.({ err }, 'sumangal_dashboard');
    res.status(err.status || 500).json({ error: err.message });
  }
};
const cid = (req) => req.company.id;
const report = (path, fn) => router.get(path, protect, wrap((req) => fn(cid(req), req.query)));

report('/meta', reports.meta);
report('/summary', reports.summary);
report('/intent/alerts', reports.intentAlerts);
report('/intent/today', reports.intentToday);
report('/intent/month', reports.intentMonth);
report('/intent/long-term', reports.intentLongTerm);
report('/intent/decisions', reports.intentDecisions);
report('/what-changed', reports.whatChanged);
report('/actions', reports.actions);
report('/problem-parts', reports.problemParts);
report('/orders', reports.orders);
report('/production', reports.production);
report('/quality', reports.quality);
report('/melting', reports.melting);
report('/customers', reports.customers);
report('/delays', reports.delays);
report('/plan', reports.plan);
report('/yield', reports.yieldReport);
report('/vendors', reports.vendors);
report('/journey', reports.journey);
report('/time-spent', reports.timeSpent);
report('/planning', reports.planning);
report('/batches', reports.batches);
report('/rhythm', reports.shippingRhythm);
report('/ready-waiting', reports.readyWaiting);
report('/orders-per-shipment', reports.ordersPerShipment);
report('/vendor', reports.vendorDetail);
report('/machining-orders', reports.machiningOrders);
report('/material-suppliers', reports.materialSuppliers);
router.get('/step/:slug', protect, wrap((req) => reports.step(cid(req), req.params.slug, req.query)));
router.get('/customers/:id', protect, wrap((req) => reports.customerDetail(cid(req), req.params.id, req.query)));
router.get('/parts/:id', protect, wrap((req) => reports.partDetail(cid(req), req.params.id, req.query)));
router.get('/lines/:id', protect, wrap((req) => reports.lineDetail(cid(req), req.params.id)));

export default router;
