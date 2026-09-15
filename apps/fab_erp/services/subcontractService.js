/**
 * subcontractService.js — sending work OUT: raising a subcontract order.
 *
 * A subcontract order is a `fab_orders` row with `order_type='subcontract'`,
 * pointed back at the sales order that caused it via `source_order_id`, with
 * ONE `fab_order_lines` row per item/step being sent to the supplier — the
 * same shape `procurementOrderService.js` uses for a purchase order, because
 * both are "a document addressed to a supplier, raised off this sales order".
 *
 * UNLIKE a purchase request, this ALWAYS raises a NEW order rather than
 * rewriting an open one. EU-1's `mo_source_key_active` idempotency key
 * deliberately does not cover subcontract orders (it is generated NULL for
 * any `order_type` other than 'manufacturing') because several are
 * legitimate for one sales order — one per supplier, or several trips to the
 * same supplier over the life of a job. With no unique key to lean on, the
 * only guard against two concurrent callers both raising a duplicate is the
 * `FOR UPDATE` lock on the sales order row below (the same guard
 * `procurementOrderService.requestProcurement` takes for the same reason).
 *
 * Sending the physical steel out and back is recorded separately, on the
 * TASK, not on this order: starting/stopping a task whose operation is
 * `is_subcontract` stamps `sent_out_at`/`returned_at` on
 * `fab_project_tasks` (see `routes/tasks.js`). This order is the paperwork —
 * which supplier, which items, when raised — not the shop-floor event.
 */

import { pool } from '../../../db.js';
import { generateCode } from './codegenService.js';

/**
 * Raise a subcontract order for one supplier, for a set of already
 * materialized tasks whose operation is `is_subcontract = 1`.
 *
 * @param {number[]} taskIds - `fab_project_tasks` ids on THIS sales order.
 * @returns {Promise<{id:number, orderNumber:string, supplierId:number,
 *   supplierName:string, lineCount:number}>}
 */
export async function raiseSubcontractOrder(companyId, orderId, supplierId, taskIds, { createdBy = null } = {}) {
  const ids = [...new Set((taskIds ?? []).map(Number).filter((n) => n > 0))];
  if (!ids.length) {
    const e = new Error('Select at least one step to send out.'); e.status = 400; throw e;
  }
  const supId = Number(supplierId);
  if (!supId) { const e = new Error('Choose a supplier.'); e.status = 400; throw e; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // FOR UPDATE for the reason explained at the top of this file: no unique
    // key exists to catch two concurrent callers both raising an order for
    // the same steps.
    const [[sales]] = await conn.query(
      `SELECT id, order_number, order_type, required_date, plant_id FROM fab_orders
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [orderId, companyId],
    );
    if (!sales) { const e = new Error('Sales order not found'); e.status = 404; throw e; }
    // A quote is not real work yet — nothing can be physically sent out for
    // one. Same refusal shape procurementOrderService/productionOrderService
    // already use for a quote (EU-13).
    if (sales.order_type === 'quote') {
      const e = new Error('This is a quote. Convert it to a sales order before raising a subcontract order.');
      e.status = 409; e.code = 'QUOTE_CANNOT_RAISE'; throw e;
    }

    const [[supplier]] = await conn.query(
      `SELECT id, name FROM fab_suppliers WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [supId, companyId],
    );
    if (!supplier) { const e = new Error('Supplier not found.'); e.status = 404; throw e; }

    const [tasks] = await conn.query(
      `SELECT t.id, t.item_id AS itemId, t.task_qty AS taskQty,
              i.code AS itemCode, i.name AS itemName, i.unit,
              op.name AS operationName, op.is_subcontract AS isSubcontract
         FROM fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id AND i.deleted_at IS NULL
         JOIN fab_operations op ON op.id = t.operation_id AND op.company_id = t.company_id
        WHERE t.id IN (?) AND t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
        FOR UPDATE`,
      [ids, companyId, orderId],
    );
    if (tasks.length !== ids.length) {
      const e = new Error('One or more steps were not found on this order.'); e.status = 404; throw e;
    }
    const notSubcontract = tasks.filter((t) => !t.isSubcontract);
    if (notSubcontract.length) {
      const e = new Error('Every step sent out must be a subcontract operation.');
      e.status = 409; e.code = 'NOT_SUBCONTRACT';
      e.detail = { taskIds: notSubcontract.map((t) => t.id) };
      throw e;
    }

    // The order/lines pair follows procurementOrderService's own shape for a
    // purchase order (line 152-171 of that file) — same idiom, different
    // order_type, so a reader who already knows that flow reads this one for
    // free.
    const orderNumber = await generateCode(companyId, 'subcontract_order', {}, conn);
    const [ins] = await conn.query(
      `INSERT INTO fab_orders
         (company_id, order_number, order_type, status, supplier_id, source_order_id,
          plant_id, required_date, created_by, notes)
       VALUES (?, ?, 'subcontract', 'requested', ?, ?, ?, ?, ?, ?)`,
      [companyId, orderNumber, supplier.id, orderId, sales.plant_id ?? null,
        sales.required_date ?? null, createdBy, `Subcontracted from ${sales.order_number}`],
    );
    const subOrderId = ins.insertId;

    let lineNo = 1;
    await conn.query(
      `INSERT INTO fab_order_lines
         (company_id, order_id, line_no, code, description, qty, unit, status)
       VALUES ?`,
      [tasks.map((t) => [
        companyId, subOrderId, lineNo++, t.itemCode ?? null,
        `${t.operationName ?? 'Subcontract'} — ${t.itemName ?? ''}`.trim(),
        Number(t.taskQty) || 1, t.unit ?? null, 'open',
      ])],
    );

    await conn.commit();
    return {
      id: subOrderId, orderNumber, supplierId: supplier.id, supplierName: supplier.name,
      lineCount: tasks.length,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
