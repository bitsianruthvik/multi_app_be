/**
 * orders.js — sales orders (the projects) and their lines.
 *
 *   GET    /orders?status=&orderType=&customerId=&search=&open=1
 *   POST   /orders                     { orderType, customerId?, title?, customerReference?, receivedOn?, committedDate?, deliveryAddress?, notes?, code? }
 *   GET    /orders/:id                 header + lines (+ structure counts per custom line) + total; each line rate, rateBasis, billed, billedUom, amount, amountNote
 *   PUT    /orders/:id                 header fields; the number only while the order has no lines
 *   POST   /orders/:id/status          { status }  — inquiry, quoted, confirmed, closed, lost, cancelled (customer)
 *                                                   draft, confirmed, closed, cancelled (stock)
 *   DELETE /orders/:id                 draft, inquiry, lost or cancelled orders only — not a revision (discard it)
 *   POST   /orders/:id/revise          the next revision of the order: a copy of it, unlocked (revisionService)
 *   DELETE /orders/:id/revision        takes the latest revision away while none of its lines is locked
 *   POST   /orders/:id/lines           { recordId, quantity, committedDate?, description?, lineNo?, notes?, rate?, rateBasis? }
 *                                      (no rate on a catalog item = its list price and basis)
 *   PUT    /order-lines/:id            { quantity?, committedDate?, description?, lineNo?, notes?, rate?, rateBasis? }
 *                                      rate/rateBasis also on a locked or released line (init.sql §36)
 *   DELETE /order-lines/:id            a custom line takes its structure with it
 *   GET    /order-lines/:id/structure  the whole structure the line sells
 *   GET    /order-lines/:id/cut-plates the blanks its plate parts are cut from
 *   POST   /order-lines/:id/cut-plates { flowId? } — work them out again; re-runnable
 *   POST   /order-lines/:id/cut-plates/flow { flowId? } — give every cut plate with no flow the house flow; { count }
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, handle, ctx, intParam } from '../lib/http.js';
import {
  listOrders, getOrder, createOrder, updateOrder, setOrderStatus, deleteOrder,
  addOrderLine, updateOrderLine, removeOrderLine, lineStructure,
} from '../services/salesOrderService.js';
import { deriveCutPlates, getCutPlates, setCutPlateFlows } from '../services/cutPlateService.js';
import { assertLineUnlocked } from '../services/lockService.js';
import { reviseOrder, discardRevision } from '../services/revisionService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);

router.get('/orders', guard(PERM.ordersView), handle((req) => listOrders(pool, ctx(req).companyId, req.query)));
router.post('/orders', guard(PERM.orders), handle((req) => tx(req, (db, c) => createOrder(db, c, req.body ?? {}))));
router.get('/orders/:id', guard(PERM.ordersView), handle((req) => getOrder(pool, ctx(req).companyId, id(req))));
router.put('/orders/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => updateOrder(db, c, id(req), req.body ?? {}))));
router.post('/orders/:id/status', guard(PERM.orders), handle((req) => tx(req, (db, c) => setOrderStatus(db, c, id(req), req.body?.status))));
router.delete('/orders/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => deleteOrder(db, c, id(req)))));
// A change after lock is a new revision of the same order (init.sql §27). Both
// write the whole order in one transaction, so a refusal leaves nothing behind.
router.post('/orders/:id/revise', guard(PERM.orders), handle((req) => tx(req, (db, c) => reviseOrder(db, c, id(req)))));
router.delete('/orders/:id/revision', guard(PERM.orders), handle((req) => tx(req, (db, c) => discardRevision(db, c, id(req)))));

router.post('/orders/:id/lines', guard(PERM.orders), handle((req) => tx(req, (db, c) => addOrderLine(db, c, id(req), req.body ?? {}))));
router.put('/order-lines/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => updateOrderLine(db, c, id(req), req.body ?? {}))));
router.delete('/order-lines/:id', guard(PERM.orders), handle((req) => tx(req, (db, c) => removeOrderLine(db, c, id(req)))));
// A read that may write: an editable line's selection rows the system can answer (a default, or one candidate) are chosen first — so it runs in a transaction.
router.get('/order-lines/:id/structure', guard(PERM.ordersView), handle((req) => tx(req, (db, c) => lineStructure(db, c.companyId, id(req), { c }))));

// Cut plates change the line's structure, so they sit behind the same grant as
// the rest of it: seeing them is a read, working them out is managing the order.
router.get('/order-lines/:id/cut-plates', guard(PERM.ordersView), handle((req) => getCutPlates(pool, ctx(req).companyId, id(req))));
// A locked line's cut pieces are part of what it was rolled out from.
router.post('/order-lines/:id/cut-plates', guard(PERM.orders), handle((req) => tx(req, async (db, c) => {
  await assertLineUnlocked(db, c.companyId, id(req));
  return deriveCutPlates(db, c, id(req), req.body ?? {});
})));

// One button for "every cut plate of this line has no flow": sets the house's
// cut-plate flow (or the flow named in the body) on the ones that have none. Still allowed on a
// locked line until release, like any flow change.
router.post('/order-lines/:id/cut-plates/flow', guard(PERM.orders), handle((req) => tx(req, (db, c) => setCutPlateFlows(db, c, id(req), req.body ?? {}))));

export default router;
