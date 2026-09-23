/**
 * purchase.js — buying what the released jobs are short of (Phase 6).
 *
 *   GET    /buy-list?show=&search=      what is short, item by item
 *   POST   /buy-list/suggest            writes (or rewrites) the suggested draft order
 *   GET    /purchase-orders?status=&supplierId=&search=
 *   POST   /purchase-orders             { code?, supplierId?, expectedDate?, notes? }
 *   GET    /purchase-orders/:id
 *   PUT    /purchase-orders/:id         { supplierId?, expectedDate?, notes? }
 *   POST   /purchase-orders/:id/order   { supplierId? } — draft → ordered
 *   POST   /purchase-orders/:id/cancel  { reason? }
 *   POST   /purchase-orders/:id/lines   { itemId, quantity, expectedDate?, note? }
 *   PUT    /purchase-lines/:id          { quantity?, expectedDate?, note? }
 *   DELETE /purchase-lines/:id
 *   POST   /purchase-lines/:id/receive  { quantity?, stockingAreaId, batch?/batchId?, movementDate?, reference?, notes? }
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  buyList, suggestPurchase, listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder,
  addPurchaseLine, updatePurchaseLine, removePurchaseLine, markOrdered, cancelPurchaseOrder, receiveLine,
} from '../services/purchaseService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);

router.get('/buy-list', view, handle((req) => buyList(pool, company(req), req.query)));
router.post('/buy-list/suggest', manage, handle((req) => tx(req, (db, c) => suggestPurchase(db, c))));

router.get('/purchase-orders', view, handle((req) => listPurchaseOrders(pool, company(req), req.query)));
router.post('/purchase-orders', manage, handle((req) => tx(req, (db, c) => createPurchaseOrder(db, c, req.body ?? {}))));
router.get('/purchase-orders/:id', view, handle((req) => getPurchaseOrder(pool, company(req), id(req))));
router.put('/purchase-orders/:id', manage, handle((req) => tx(req, (db, c) => updatePurchaseOrder(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/order', manage, handle((req) => tx(req, (db, c) => markOrdered(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/cancel', manage, handle((req) => tx(req, (db, c) => cancelPurchaseOrder(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/lines', manage, handle((req) => tx(req, (db, c) => addPurchaseLine(db, c, id(req), req.body ?? {}))));

router.put('/purchase-lines/:id', manage, handle((req) => tx(req, (db, c) => updatePurchaseLine(db, c, id(req), req.body ?? {}))));
router.delete('/purchase-lines/:id', manage, handle((req) => tx(req, (db, c) => removePurchaseLine(db, c, id(req)))));
router.post('/purchase-lines/:id/receive', manage, handle((req) => tx(req, (db, c) => receiveLine(db, c, id(req), req.body ?? {}))));

export default router;
