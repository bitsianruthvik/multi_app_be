import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import * as reports from '../services/reportService.js';
import * as flow from '../services/flowService.js';
import { v15Data } from '../services/v15Service.js';

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

// ERP dashboard (V15): the whole dataset, gzipped once and cached; the page works everything out in the browser.
router.get('/v15/data', protect, async (req, res) => {
  try {
    const { key, gz } = await v15Data(cid(req));
    if (req.headers['if-none-match'] === key) return res.status(304).end();
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'x-no-compression': '1', ETag: key, 'Cache-Control': 'private, no-cache' });
    res.end(gz);
  } catch (err) {
    if (!err.status) req.log?.error?.({ err }, 'sumangal_dashboard v15');
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

// By flow dashboard: mode=asis|historic; production also takes g=day|week|month|year and stage.
router.get('/flow/customers', protect, wrap((req) => flow.flowCustomers(cid(req), req.query, req.query.mode)));
router.get('/flow/planning', protect, wrap((req) => flow.flowPlanning(cid(req), req.query, req.query.mode)));
router.get('/flow/production', protect, wrap((req) => flow.flowProduction(cid(req), req.query, req.query.mode, { g: req.query.g, stage: req.query.stage })));
router.get('/flow/dispatch', protect, wrap((req) => flow.flowDispatch(cid(req), req.query, req.query.mode)));
router.get('/flow/vendors', protect, wrap((req) => flow.flowVendors(cid(req), req.query, req.query.mode)));
