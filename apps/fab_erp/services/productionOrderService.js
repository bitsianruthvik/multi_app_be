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
import { materializeOrderTasks } from './taskGatingService.js';

/**
 * A production order's life, and what moves it.
 *
 *   draft          raised, with its DAG already built. Nobody has committed to
 *                  it yet, so nothing advances it automatically — approval is a
 *                  person's decision and the system must not make it by
 *                  materialising some tasks.
 *   waiting        approved, and every task is still blocked. The shop cannot
 *                  start: there is nothing to put on a machine.
 *   in_production  at least one task is ELIGIBLE — its material is on hand and
 *                  its predecessors are done. That is what "the first raw
 *                  material it needs turns up" means in this schema, and it is
 *                  why receiving stock has to re-check this order.
 *   completed      every task done.
 *
 * `eligible` is the load-bearing status. A task sits `blocked` until
 * taskGatingService clears it, which happens when stock arrives — so the
 * waiting → in_production move is a consequence of the gate opening rather than
 * a separate thing to remember to do.
 */
export const MO_STATUS = {
  DRAFT: 'draft',
  WAITING: 'waiting',
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

    /**
     * The DAG is built HERE, as part of raising the order.
     *
     * It used to be a separate step somebody had to remember, which meant a
     * production order could exist describing work that had never been broken
     * down — a document about nothing. Raising the order and having the work to
     * do are the same act, so they happen together.
     *
     * Idempotent by materializeOrderTasks' own per-(item, flow step) key, so
     * raising an order whose tree is already built adds nothing and re-raising
     * after the BOM grew adds only what is new.
     */
    const materialized = await materializeOrderTasks(conn, companyId, orderId);

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
      tasksMaterialized: materialized?.tasksInserted ?? 0,
      itemsSkipped: materialized?.itemsSkipped ?? 0,
    };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * Approve a production order: draft → waiting, and then wherever the work is.
 *
 * Approval is the one transition a person makes. Everything after it is a
 * consequence of the shop floor, so this hands straight over to the roll-up —
 * an order whose material is ALREADY in stock has nothing to wait for and goes
 * to in_production immediately rather than sitting in a waiting state that was
 * never true.
 */
export async function approveProductionOrder(companyId, productionOrderId) {
  const [[mo]] = await pool.query(
    `SELECT id, status FROM fab_orders
      WHERE id = ? AND company_id = ? AND order_type = 'manufacturing' AND deleted_at IS NULL
      LIMIT 1`,
    [productionOrderId, companyId],
  );
  if (!mo) throw new Error('Production order not found');
  if (mo.status === MO_STATUS.CANCELLED) throw new Error('That production order is cancelled');
  if (mo.status !== MO_STATUS.DRAFT) {
    // Already approved. Not an error — re-reading where it stands is useful.
    return rollUpProductionOrder(pool, companyId, productionOrderId);
  }

  await pool.query(
    `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ?`,
    [MO_STATUS.WAITING, productionOrderId, companyId],
  );
  return rollUpProductionOrder(pool, companyId, productionOrderId);
}

/**
 * Move a production order's status to match the tasks it owns.
 *
 * A DRAFT IS NEVER ADVANCED. Approval is a commitment somebody makes, and
 * materialising tasks or receiving steel must not make it on their behalf —
 * the same reason task automation is forbidden from advancing a draft sales
 * order. Progress is still recorded, so a draft shows what it would be.
 *
 * Past draft it is deliberately NOT forward-only: re-materialising the DAG can
 * legitimately add unstarted work to a job that had been finished, and saying
 * `completed` there would be a lie the sales order then inherits.
 *
 * THIS FUNCTION DOES NOT TOUCH THE SALES ORDER. It used to, and that made the
 * dependency circular the moment the sales order started mirroring this one.
 * `taskEngineService.rollUpOrderStatus` is now the single entry point that
 * refreshes both — it calls this first and then mirrors the result — so every
 * existing caller of it (task start, task complete, materialise, re-materialise)
 * keeps both documents current without knowing this exists.
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
            SUM(status = 'eligible')                 AS eligible,
            SUM(status NOT IN ('done', 'cancelled')) AS remaining
       FROM fab_project_tasks
      WHERE company_id = ? AND production_order_id = ? AND deleted_at IS NULL`,
    [companyId, productionOrderId],
  );
  const total = Number(agg?.total) || 0;
  const done = Number(agg?.done) || 0;
  const active = Number(agg?.active) || 0;
  const eligible = Number(agg?.eligible) || 0;
  const remaining = Number(agg?.remaining) || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Progress is recorded either way; only the status is withheld from a draft.
  if (mo.status === MO_STATUS.DRAFT) {
    await exec.query(
      `UPDATE fab_orders SET progress_pct = ? WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [pct, productionOrderId, companyId],
    );
    return { status: MO_STATUS.DRAFT, progressPct: pct, total, done, active, eligible };
  }

  let target;
  if (total === 0) target = MO_STATUS.WAITING;
  else if (remaining === 0 && done > 0) target = MO_STATUS.DONE;
  // Anything started, finished, or STARTABLE means the shop has its first
  // input — an eligible task is one whose material is on hand.
  else if (done > 0 || active > 0 || eligible > 0) target = MO_STATUS.IN_PROGRESS;
  else target = MO_STATUS.WAITING;

  await exec.query(
    `UPDATE fab_orders SET status = ?, progress_pct = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [target, pct, productionOrderId, companyId],
  );

  return { status: target, progressPct: pct, total, done, active, eligible };
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
