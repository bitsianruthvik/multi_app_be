/**
 * orders.js — sales orders (the projects) and their lines.
 *
 *   GET    /orders?status=&orderType=&customerId=&search=&open=1
 *   POST   /orders                     { orderType, customerId?, title?, customerReference?, receivedOn?, committedDate?, deliveryAddress?, notes?, code? }
 *   GET    /orders/:id                 header + lines (+ structure counts per custom line)
 *   PUT    /orders/:id                 header fields; the number only while the order has no lines
 *   POST   /orders/:id/status          { status }  — inquiry, quoted, confirmed, closed, lost, cancelled (customer)
 *                                                   draft, confirmed, closed, cancelled (stock)
 *   DELETE /orders/:id                 draft, inquiry, lost or cancelled orders only
 *   POST   /orders/:id/lines           { recordId, quantity, committedDate?, description?, lineNo?, notes? }
 *   PUT    /order-lines/:id            { quantity?, committedDate?, description?, lineNo?, notes? }
 *   DELETE /order-lines/:id            a custom line takes its structure with it
 *   GET    /order-lines/:id/structure  the whole structure the line sells
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listOrders, getOrder, createOrder, updateOrder, setOrderStatus, deleteOrder,
  addOrderLine, updateOrderLine, removeOrderLine, lineStructure,
} from '../services/salesOrderService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

router.get('/orders', guard(PERM.ordersView), handle((req) => listOrders(pool, ctx(req).companyId, req.query)));
router.post('/orders', guard(PERM.orders), handle((req) => tx(req, (db, c) => createOrder(db, c, req.body ?? {}))));
router.get('/orders/:id', guard(PERM.ordersView), handle((req) => getOrder(pool, ctx(req).companyId, id(req))));
router.put('/orders/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => updateOrder(db, c, id(req), req.body ?? {}))));
router.post('/orders/:id/status', guard(PERM.orders), handle((req) => tx(req, (db, c) => setOrderStatus(db, c, id(req), req.body?.status))));
router.delete('/orders/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => deleteOrder(db, c, id(req)))));

router.post('/orders/:id/lines', guard(PERM.orders), handle((req) => tx(req, (db, c) => addOrderLine(db, c, id(req), req.body ?? {}))));
router.put('/order-lines/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => updateOrderLine(db, c, id(req), req.body ?? {}))));
router.delete('/order-lines/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => removeOrderLine(db, c, id(req)))));
router.get('/order-lines/:id/structure', guard(PERM.ordersView), handle((req) => lineStructure(pool, ctx(req).companyId, id(req))));

export default router;
