/**
 * stores.js — the STORES CHAIN (init.sql §79, user 2026-10-18; contract TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Stores
 * chain"). Need → MR → STORES (take from stock, raise the PR) → Purchase (quotes → PO) → Management → Stores GRN → stock.
 *
 *   POST /requisitions { forType, orderId?, maintenanceOrderId?, note?, lines: [{ itemId, qty, uom? }] } → { id, code }
 *        the GENERAL MR (requisitionService.createRequisition) — "New MR": a REQUEST TO STORES for a sales order (from the
 *        order's page) or a maintenance order (§82); since 2026-11-23 nothing else (MR_FROM); it lands in the MR inbox
 *   POST /stores/purchase-requests { the same body } → { requisition, materialRequest, purchaseRequest }
 *        Stores' own "New PR" (§93, user 2026-10-27): straight to a PR for Purchase (purchaseRequestService.raiseStoresPr;
 *        the MR underneath is internal — not in the MR inbox)
 *   GET  /stores/reorder?search=                         "To reorder" (by AI): min / max and periodic items that need buying
 *   POST /stores/reorder/raise { rows: [{ itemId, qty }], note? }   ticked rows → "Raise PR": ONE PR for stock (as New PR)
 *   GET  /procurement/:id                                 how an item / definition is procured (own, inherited, effective)
 *   PUT  /procurement/:id { method|null, minQty?, maxQty?, periodDays?, leadTimeDays?, orderMultiple?, minOrderQty?, preferredVendorIds? }
 *   POST /machines/:id/store                              the machine's own store (found or made) — the ground for S8
 * The MR inbox and the MR screen are GET /material-requests?for=… and /material-requests/:id (routes/purchaseRequests.js).
 * Each route takes the new tag or the older one that already reached the screen (admins pass everywhere).
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { invalid } from '../lib/errors.js';
import { createRequisition } from '../services/requisitionService.js';
import { reorderSuggestions, raiseReorder, readProcurement, setProcurement } from '../services/procurementMethodService.js';
import { raiseStoresPr } from '../services/purchaseRequestService.js';
import { machineStore } from '../services/stockingAreaService.js';

const router = Router();
const id = (req) => intParam(req.params.id);
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const body = (req) => req.body ?? {};
const storesView = guardAny(PERM.stores, PERM.inventoryView);
const storesManage = guardAny(PERM.stores, PERM.inventory);

// Stores raise any MR; maintenance raises its own; whoever manages orders may raise one for an order.
// 2026-11-22 (user): a request to Stores comes from someone else — Stores' own purchases go through /stores/purchase-requests.
// 2026-11-23 (user): "MR should be on sales order or machine only. We don't want MR to be randomly created" — a request
// names its sales order (raised from the order's page) or its maintenance order (raised from the machine's ticket).
// Stores' own buying stays New PR / To reorder (internal MRs, never through here).
const MR_FROM = ['sales_order', 'maintenance_order'];
router.post('/requisitions', guardAny(PERM.maintenance, PERM.orders, PERM.production), handle((req) => {
  if (!MR_FROM.includes(String(body(req).forType ?? ''))) throw invalid('MR_FROM', 'A material request is raised from its sales order (New MR on the order) or from the maintenance order of a machine — not on its own.');
  return tx(req, (db, c) => createRequisition(db, c, body(req)));
}));
// §93: Stores' own purchase (New PR, To reorder's Raise PR) — Stores alone (or the older inventory manage), as the reorder.
router.post('/stores/purchase-requests', storesManage, handle((req) => tx(req, (db, c) => raiseStoresPr(db, c, body(req)))));
router.get('/stores/reorder', storesView, handle((req) => reorderSuggestions(pool, ctx(req).companyId, req.query)));
router.post('/stores/reorder/raise', storesManage, handle((req) => tx(req, (db, c) => raiseReorder(db, c, body(req)))));
router.get('/procurement/:id', guardAny(PERM.view, PERM.stores, PERM.inventoryView), handle((req) => readProcurement(pool, ctx(req).companyId, id(req))));
router.put('/procurement/:id', guardAny(PERM.catalog, PERM.stores), handle((req) => tx(req, (db, c) => setProcurement(db, c, id(req), body(req)))));
router.post('/machines/:id/store', guardAny(PERM.stores, PERM.inventory, PERM.maintenance), handle((req) => tx(req, (db, c) => machineStore(db, c, id(req)))));

export default router;
