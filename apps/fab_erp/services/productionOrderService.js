/**
 * productionOrderService.js — the make side of a sales order, as a document.
 *
 * ONE production order per sales order. Not one per item: a sales order for a
 * bridge span is one thing being built, and 465 manufacturing orders for its
 * every plate and stiffener would be 465 documents nobody reads describing one
 * job. The BOM already carries that detail; the production order tracks the job.
 *
 * WHAT IT MEANS FOR IT TO "OWN THE DAG"
 *
 * `fab_project_tasks.order_id` still points at the SALES order and is not
 * repointed. Roughly twenty modules read it — critical chain, drum sequencing,
 * dispatch ranking, buffers, shift log, machine analytics, reconciliation,
 * readiness — and each reaches order priority and dates through it. Moving
 * 2154 live rows to a new parent would rewrite all of that at once.
 *
 * So the production order claims its tasks through `production_order_id`, an
 * additive nullable column. The DAG is queryable from the production order,
 * which is what "the DAG lives in it" has to mean in practice; everything that
 * reads tasks by sales order keeps working untouched; and the decision stays
 * reversible, which repointing the rows would not be.
 *
 * ONLY MAKE TASKS ARE CLAIMED. A task hanging off a bought-in item is not
 * production work — it is something arriving on a lorry, and it belongs to the
 * procurement side.
 */

import { pool } from '../../../db.js';
import { DEFAULT_PROCUREMENT } from './procurementService.js';

export const MO_STATUS = {
  DRAFT: 'draft',
  RELEASED: 'released',
  IN_PROGRESS: 'in_production',
  DONE: 'completed',
  CANCELLED: 'cancelled',
};

async function nextOrderNumber(exec, companyId, prefix, stampYmd) {
  const [[row]] = await exec.query(
    `SELECT order_number FROM fab_orders
      WHERE company_id = ? AND order_number LIKE ?
      ORDER BY id DESC LIMIT 1`,
    [companyId, `${prefix}-%`],
  );
  let seq = 1;
  if (row?.order_number) {
    const n = parseInt(String(row.order_number).split('-').pop(), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}-${stampYmd}-${String(seq).padStart(4, '0')}`;
}

/**
 * Create (or find) the production order for a sales order and claim its tasks.
 *
 * Idempotent: a sales order has at most one production order, so calling this
 * twice re-claims tasks onto the existing one rather than raising a second.
 * Re-claiming matters — materializing more tasks later must not leave them
 * orphaned outside the order that is supposed to be tracking them.
 */
export async function ensureProductionOrder(companyId, orderId, opts = {}) {
  const conn = opts.conn ?? await pool.getConnection();
  const owned = !opts.conn;
  try {
    if (owned) await conn.beginTransaction();

    const [[sales]] = await conn.query(
      `SELECT id, order_number, required_date, plant_id, scheduled_start, scheduled_end
         FROM fab_orders
        WHERE id = ? AND company_id = ? AND order_type = 'sales' AND deleted_at IS NULL
        LIMIT 1`,
      [orderId, companyId],
    );
    if (!sales) throw new Error('Sales order not found');

    let [[mo]] = await conn.query(
      `SELECT id, order_number, status FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
          AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [companyId, orderId],
    );

    let created = false;
    if (!mo) {
      const [[{ ymd }]] = await conn.query("SELECT DATE_FORMAT(UTC_DATE(), '%Y%m%d') AS ymd");
      const orderNumber = await nextOrderNumber(conn, companyId, 'MO', ymd);
      const [ins] = await conn.query(
        `INSERT INTO fab_orders
           (company_id, order_number, order_type, status, source_order_id, plant_id,
            required_date, scheduled_start, scheduled_end, created_by, notes)
         VALUES (?, ?, 'manufacturing', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, orderNumber, MO_STATUS.DRAFT, orderId, sales.plant_id ?? null,
          sales.required_date ?? null, sales.scheduled_start ?? null,
          sales.scheduled_end ?? null, opts.createdBy ?? null,
          `Production for ${sales.order_number || `sales order ${orderId}`}`],
      );
      mo = { id: ins.insertId, order_number: orderNumber, status: MO_STATUS.DRAFT };
      created = true;
    }

    // Claim every make task on this sales order. A task whose item is bought in
    // is not production work and is left alone.
    const [claim] = await conn.query(
      `UPDATE fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
          SET t.production_order_id = ?
        WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
          AND COALESCE(i.procurement_type, ?) = 'make'
          AND (t.production_order_id IS NULL OR t.production_order_id <> ?)`,
      [mo.id, companyId, orderId, DEFAULT_PROCUREMENT, mo.id],
    );

    if (owned) await conn.commit();
    return {
      id: mo.id,
      orderNumber: mo.order_number,
      status: mo.status,
      created,
      tasksClaimed: claim?.affectedRows ?? 0,
    };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * Move a production order's status to match the tasks it owns.
 *
 * Deliberately NOT forward-only, unlike the sales order's own lifecycle: a
 * production order is a description of work in progress, and re-materializing
 * the DAG can legitimately add unstarted work to a job that had been finished.
 * Saying `completed` there would be a lie the sales order would then inherit.
 * A cancelled order is still left alone.
 */
export async function rollUpProductionOrder(exec, companyId, productionOrderId) {
  if (!productionOrderId) return null;
  const [[mo]] = await exec.query(
    `SELECT id, status FROM fab_orders
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [productionOrderId, companyId],
  );
  if (!mo || mo.status === MO_STATUS.CANCELLED) return null;

  const [[agg]] = await exec.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'done')                     AS done,
            SUM(status IN ('in_progress', 'paused')) AS active,
            SUM(status NOT IN ('done', 'cancelled')) AS remaining
       FROM fab_project_tasks
      WHERE company_id = ? AND production_order_id = ? AND deleted_at IS NULL`,
    [companyId, productionOrderId],
  );
  const total = Number(agg?.total) || 0;
  const done = Number(agg?.done) || 0;
  const active = Number(agg?.active) || 0;
  const remaining = Number(agg?.remaining) || 0;

  let target = MO_STATUS.DRAFT;
  if (total > 0) {
    if (remaining === 0 && done > 0) target = MO_STATUS.DONE;
    else if (done > 0 || active > 0) target = MO_STATUS.IN_PROGRESS;
    else target = MO_STATUS.RELEASED;
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  await exec.query(
    `UPDATE fab_orders SET status = ?, progress_pct = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [target, pct, productionOrderId, companyId],
  );
  return { status: target, progressPct: pct, total, done, active };
}

/** The production order for a sales order, with the shape of its DAG. */
export async function productionForOrder(companyId, orderId, conn) {
  const exec = conn ?? pool;
  const [[mo]] = await exec.query(
    `SELECT id, order_number, status, progress_pct, required_date, created_at
       FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [companyId, orderId],
  );
  if (!mo) return null;

  const [[agg]] = await exec.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'done')                     AS done,
            SUM(status IN ('in_progress', 'paused')) AS active,
            SUM(status = 'blocked')                  AS blocked
       FROM fab_project_tasks
      WHERE company_id = ? AND production_order_id = ? AND deleted_at IS NULL`,
    [companyId, mo.id],
  );

  return {
    id: mo.id,
    orderNumber: mo.order_number,
    status: mo.status,
    progressPct: Number(mo.progress_pct) || 0,
    requiredDate: mo.required_date,
    tasks: {
      total: Number(agg?.total) || 0,
      done: Number(agg?.done) || 0,
      active: Number(agg?.active) || 0,
      blocked: Number(agg?.blocked) || 0,
    },
  };
}
