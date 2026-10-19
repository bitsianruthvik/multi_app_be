/**
 * purchase.js — purchase orders and their receipts.
 *
 *   GET    /purchase-orders?status=&stage=&type=&supplierId=&search=   (stage, §71: pending_approval | waiting | part_received |
 *                                      closed | closed_short | cancelled | requested; type: material | contractor)
 *   GET    /purchase-orders/pending-lines?search=&supplierId=   Inventory › Receive against PO: lines still pending (§71)
 *   POST   /purchase-orders             { code?, supplierId?, expectedDate?, notes? }
 *   GET    /purchase-orders/:id
 *   PUT    /purchase-orders/:id         { supplierId?, expectedDate?, notes? }
 *   POST   /purchase-orders/:id/order   { supplierId? } — send for approval (§71: it no longer places it; §73: a row of the Management inbox)
 *   POST   /purchase-orders/:id/approve { note? } — Management approves (§73: through the inbox — cf_erp_approve_purchase_order, or
 *                                      cf_erp_approve_contractor_po for a contractor PO): pending → waiting for goods
 *   POST   /purchase-orders/:id/reject  { note } — Management sends it back to the buyer (not placed)
 *   POST   /purchase-orders/:id/close   { reason } — ASK to close short (§73: cf_erp_approve_po_close_short approves it in the inbox);
 *                                      on approval what is pending is released and the PR line's "PO raised" goes down
 *   POST   /purchase-orders/:id/cancel  { reason? }
 *   POST   /purchase-orders/:id/lines   { itemId, quantity, expectedDate?, note?, unitPrice? }  (no unitPrice = last price paid)
 *   PUT    /purchase-lines/:id          { quantity?, expectedDate?, note?, unitPrice? }  (null clears)
 *   DELETE /purchase-lines/:id
 *   POST   /purchase-lines/:id/receive  { quantity?, stockingAreaId, batch?/batchId?, movementDate?, reference?, notes?, unitCost? }
 *                                      a GRN (several per PO). unitCost defaults to the line's unitPrice; the share bought for a
 *                                      sales order / MR line is earmarked to it -> { movement, held, order }. All received → the PO closes.
 *   PUT    /purchase-lines/:id/orders   { orders: [{ orderId, quantity }] }  which sales orders the line is bought for (§43)
 *   POST   /stock/holds/:id/release     lets a hold go -> { ok }
 *   POST /purchase-orders and PUT /purchase-orders/:id take forOrderId (the default for lines added later);
 *   POST /purchase-orders/:id/lines takes orderId (null = for stock; left out = the header's)
 * Permissions (2026-10-19): reading a PO — inventory view, Purchase or an approval tag; making and changing POs, sending
 * them for approval, asking to close short, cancelling — cf_erp_purchase (Stores — inventory manage or cf_erp_stores — also
 * on the customer's own ₹0 PO: its dates, close, cancel); approving — the approval tags; receiving and releasing a hold —
 * inventory manage (Stores).
 * (The buy list route went with its screen, §71: the MR → PR → PO flow replaces it; buyList still feeds Home's count.)
 */
import { Router } from 'express';
import { pool, withTransaction } from '../lib/db.js';
import { PERM, guard, guardAny, handle, ctx, intParam } from '../lib/http.js';
import { isPermitted } from '../../../core/middleware/requirePerm.js';
import {
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder,
  addPurchaseLine, updatePurchaseLine, removePurchaseLine, markOrdered, cancelPurchaseOrder, receiveLine,
  setPurchaseLineOrders, requestCloseShort, pendingLines,
} from '../services/purchaseService.js';
import { APPROVAL_PERMS, decide, pendingOf } from '../services/approvalService.js';
import { approverOf } from './approvals.js';
import { CfError } from '../lib/errors.js';
import { releaseHold } from '../services/purchaseLinkService.js';
import { noteLegacyReceipt } from '../services/grnService.js';

const router = Router();
const tx = (req, fn) => withTransaction((db) => fn(db, ctx(req)));
const id = (req) => intParam(req.params.id);
const company = (req) => ctx(req).companyId;
const view = guard(PERM.inventoryView);
const manage = guard(PERM.inventory);
/*
 * WHO DOES WHAT ON A PO (user, 2026-10-19). Stores raises the MR / PR and books the GRN (inventory manage); PURCHASE gets
 * the quotes, raises and edits the PO, sends it for the MD's approval, asks to close it short and cancels it
 * (cf_erp_purchase). Management approves (its own approval tags). The one PO Stores makes is the customer's ₹0 PO —
 * saving the MR raises it (requisitionService.askCustomer under PUT /material-requests/:id, inventory manage or Stores) —
 * so on THAT PO Stores may still change dates, ask to close it and cancel it; every other PO is Purchase's (assertPoActor).
 */
const buy = guard(PERM.purchase);
const poWrite = guardAny(PERM.purchase, PERM.inventory, PERM.stores);
// Management approves purchase orders, so may read them without the inventory grants (§71; §73: any approval tag);
// Purchase reads the POs it raises.
const viewPo = guardAny(PERM.inventoryView, PERM.purchase, PERM.plateChangeApprove, ...APPROVAL_PERMS);

/**
 * Purchase's action on one PO (by `poId`, or the PO of `lineId`): cf_erp_purchase passes; inventory manage or Stores pass
 * only on the customer's own PO. A PO not found here (another company's, a wrong id) is left to the service's 404.
 * 1 read when the caller lacks cf_erp_purchase, none otherwise.
 */
export async function assertPoActor(db, user, companyId, { poId = null, lineId = null } = {}) {
  if (isPermitted(user, PERM.purchase)) return;
  const [[p]] = poId != null
    ? await db.query('SELECT code, supplied_by_customer FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(poId)])
    : await db.query(
      `SELECT p.code, p.supplied_by_customer FROM cf_purchase_order_lines l JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL
        WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`, [companyId, Number(lineId)]);
  if (!p) return;
  if (Number(p.supplied_by_customer ?? 0) && (isPermitted(user, PERM.inventory) || isPermitted(user, PERM.stores))) return;
  throw new CfError(403, 'FORBIDDEN', `Permission required: ${PERM.purchase} — ${p.code} is Purchase's to change (Stores changes only the customer's own PO).`);
}
/** A write on one PO, inside its transaction, after assertPoActor. */
const onPo = (req, which, fn) => tx(req, async (db, c) => { await assertPoActor(db, req.user, c.companyId, which); return fn(db, c); });
const approve = guardAny(...APPROVAL_PERMS);
/** The PO's own approval decided through the inbox (approvalService.decide checks the tag and requester ≠ approver). */
const decidePo = (decision) => handle((req) => withTransaction(async (db) => {
  const c = ctx(req);
  const row = await pendingOf(db, c.companyId, 'purchase_order', id(req), ['purchase_order', 'contractor_po']);
  if (!row) {
    const [[po]] = await db.query('SELECT id FROM cf_purchase_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id(req)]);
    throw po ? new CfError(422, 'NOT_PENDING', 'This purchase order is not waiting for approval.') : new CfError(404, 'NOT_FOUND', 'Purchase order not found.');
  }
  return (await decide(db, c, row.id, { decision, note: req.body?.note }, approverOf(req))).result;
}));

router.get('/purchase-orders', viewPo, handle((req) => listPurchaseOrders(pool, company(req), req.query)));
router.get('/purchase-orders/pending-lines', view, handle((req) => pendingLines(pool, company(req), req.query)));
router.post('/purchase-orders', buy, handle((req) => tx(req, (db, c) => createPurchaseOrder(db, c, req.body ?? {}))));
router.get('/purchase-orders/:id', viewPo, handle((req) => getPurchaseOrder(pool, company(req), id(req))));
router.put('/purchase-orders/:id', poWrite, handle((req) => onPo(req, { poId: id(req) }, (db, c) => updatePurchaseOrder(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/order', buy, handle((req) => tx(req, (db, c) => markOrdered(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/approve', approve, decidePo('approve'));
router.post('/purchase-orders/:id/reject', approve, decidePo('reject'));
router.post('/purchase-orders/:id/close', poWrite, handle((req) => onPo(req, { poId: id(req) }, (db, c) => requestCloseShort(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/cancel', poWrite, handle((req) => onPo(req, { poId: id(req) }, (db, c) => cancelPurchaseOrder(db, c, id(req), req.body ?? {}))));
router.post('/purchase-orders/:id/lines', buy, handle((req) => tx(req, (db, c) => addPurchaseLine(db, c, id(req), req.body ?? {}))));

router.put('/purchase-lines/:id', poWrite, handle((req) => onPo(req, { lineId: id(req) }, (db, c) => updatePurchaseLine(db, c, id(req), req.body ?? {}))));
router.delete('/purchase-lines/:id', buy, handle((req) => tx(req, (db, c) => removePurchaseLine(db, c, id(req)))));
// §80: a receipt booked through this older call (no money) still leaves a flagged supplier-bill row for Accounts; the GRN screen uses POST /purchase-orders/:id/grn.
router.post('/purchase-lines/:id/receive', manage, handle((req) => tx(req, async (db, c) => {
  const r = await receiveLine(db, c, id(req), req.body ?? {});
  await noteLegacyReceipt(db, c, id(req), r);
  return r;
})));
router.put('/purchase-lines/:id/orders', buy,handle((req) => tx(req, (db, c) => setPurchaseLineOrders(db, c, id(req), req.body ?? {}))));
router.post('/stock/holds/:id/release', manage, handle((req) => tx(req, (db, c) => releaseHold(db, c, id(req)))));

export default router;
