/**
 * requisitionLifecycle.js — what happens to a line's requisition (init.sql §56)
 * when its ORDER changes under it: the order is closed, lost or cancelled, a
 * line is deleted, the order is revised, a revision is discarded.
 *
 * Plain set-based SQL and no service imports, on purpose: salesOrderService and
 * revisionService call these, and requisitionService (which reads purchase
 * orders, stock and release) must not be pulled into their import graph.
 * Every function is a fixed number of statements, whatever the number of lines.
 */

const LIVE_PO = "('requested','quoting','draft','ordered','partially_received')";

/**
 * The order is closed, lost or cancelled: what was still COMING for it on
 * purchase orders is no longer for it. Each allocation is cut back to what has
 * already arrived (nothing arrived: the allocation goes), so the rest of the
 * PO line is bought for nobody — pooled supply any order may use. The holds are
 * let go by purchaseLinkService.releaseOrderHolds, as before. By order NUMBER,
 * so every revision. 1 statement.
 */
export async function releaseOrderAllocations(db, companyId, orderId) {
  // deleted_at first: it reads qty_received, which this statement does not change (a MySQL UPDATE sees its own earlier SETs).
  const [r] = await db.query(
    `UPDATE cf_purchase_line_orders a
       JOIN cf_sales_orders ao ON ao.id = a.order_id
       JOIN cf_sales_orders so ON so.company_id = ao.company_id AND so.code_active = ao.code_active
       JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id AND l.deleted_at IS NULL
       JOIN cf_purchase_orders p ON p.id = l.purchase_order_id AND p.deleted_at IS NULL AND p.status IN ${LIVE_PO}
        SET a.deleted_at = IF(a.qty_received > 0, NULL, NOW()), a.quantity = IF(a.qty_received > 0, a.qty_received, a.quantity)
      WHERE a.company_id = ? AND so.id = ? AND a.deleted_at IS NULL AND a.quantity > a.qty_received`,
    [companyId, Number(orderId)],
  );
  return r.affectedRows;
}

/**
 * Lines are being deleted (a line, an order, a discarded revision's lines):
 * their requisitions go with them. Stock held for their requisition lines is
 * free again, what was still coming for them is bought for nobody, and the
 * requisition and its lines are retired. 4 statements.
 */
export async function retireRequisitionsOfLines(db, companyId, lineIds) {
  if (!lineIds.length) return;
  await db.query(
    `UPDATE cf_stock_reservations v
       JOIN cf_requisition_lines pl ON pl.id = v.pr_line_id
        SET v.status = 'released', v.closed_at = NOW()
      WHERE v.company_id = ? AND pl.order_line_id IN (?) AND pl.deleted_at IS NULL AND v.status = 'active'`,
    [companyId, lineIds],
  );
  await db.query(
    `UPDATE cf_purchase_line_orders a
       JOIN cf_requisition_lines pl ON pl.id = a.pr_line_id
        SET a.deleted_at = IF(a.qty_received > 0, NULL, NOW()), a.quantity = IF(a.qty_received > 0, a.qty_received, a.quantity)
      WHERE a.company_id = ? AND pl.order_line_id IN (?) AND pl.deleted_at IS NULL AND a.deleted_at IS NULL AND a.quantity > a.qty_received`,
    [companyId, lineIds],
  );
  await db.query('UPDATE cf_requisition_lines SET deleted_at = NOW() WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]);
  await db.query('UPDATE cf_requisitions SET deleted_at = NOW() WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]);
}

/**
 * A REVISION was made: every line of the new revision is a copy that points
 * back at the line it replaces (revises_line_id). Each requisition moves to the
 * copy, with its lines — so the holds, the purchase allocations and the skip
 * decisions of the order stay on the line that is now the live one. Its need
 * is read again once the new line is frozen. 2 statements.
 */
export async function carryRequisitions(db, companyId, newOrderId) {
  await db.query(
    `UPDATE cf_requisitions r
       JOIN cf_sales_order_lines nl ON nl.company_id = r.company_id AND nl.revises_line_id = r.order_line_id AND nl.order_id = ? AND nl.deleted_at IS NULL
        SET r.order_id = nl.order_id, r.order_line_id = nl.id
      WHERE r.company_id = ? AND r.deleted_at IS NULL`,
    [Number(newOrderId), companyId],
  );
  await db.query(
    `UPDATE cf_requisition_lines pl
       JOIN cf_requisitions r ON r.id = pl.requisition_id
        SET pl.order_line_id = r.order_line_id
      WHERE pl.company_id = ? AND r.order_id = ? AND pl.order_line_id <> r.order_line_id`,
    [companyId, Number(newOrderId)],
  );
}

/**
 * A revision is DISCARDED: its requisitions go back to the lines they came
 * from (before the revision's lines are deleted). 1 read, 2 statements.
 */
export async function returnRequisitions(db, companyId, revisionOrderId) {
  const [rows] = await db.query(
    `SELECT r.id, ol.id AS line_id, ol.order_id
       FROM cf_requisitions r
       JOIN cf_sales_order_lines nl ON nl.id = r.order_line_id AND nl.order_id = ?
       JOIN cf_sales_order_lines ol ON ol.id = nl.revises_line_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL`,
    [Number(revisionOrderId), companyId],
  );
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const cases = () => `CASE id ${rows.map(() => 'WHEN ? THEN ?').join(' ')} END`;
  await db.query(
    `UPDATE cf_requisitions SET order_line_id = ${cases()}, order_id = ${cases()} WHERE company_id = ? AND id IN (?)`,
    [...rows.flatMap((r) => [r.id, r.line_id]), ...rows.flatMap((r) => [r.id, r.order_id]), companyId, ids],
  );
  await db.query(
    `UPDATE cf_requisition_lines SET order_line_id = CASE requisition_id ${rows.map(() => 'WHEN ? THEN ?').join(' ')} END
      WHERE company_id = ? AND requisition_id IN (?)`,
    [...rows.flatMap((r) => [r.id, r.line_id]), companyId, ids],
  );
}
