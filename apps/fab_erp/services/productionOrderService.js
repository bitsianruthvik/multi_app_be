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
import { NOT_A_BLANK, IS_A_BLANK } from './blankPredicate.js';
import { DEFAULT_PROCUREMENT } from './procurementService.js';
import { materializeOrderTasks, syncUnstartedTasks } from './taskGatingService.js';
import { generateCode, orderRowCodes, taskCodes } from './codegenService.js';

/**
 * A production order's life, and what moves it.
 *
 *   draft          raised, with its DAG already built. Times can still be typed
 *                  over and the tasks follow. Nothing advances it automatically
 *                  — deploying is a person's decision.
 *   waiting        deployed: codes written, and every task is still blocked. The shop cannot
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
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing' AND mo_purpose IS NULL
          AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [companyId, orderId],
    );

    let created = false;
    if (!mo) {
      const orderNumber = await generateCode(companyId, 'manufacturing_order', {}, conn);
      const [ins] = await conn.query(
        `INSERT INTO fab_orders
           (company_id, order_number, order_type, mo_purpose, status, source_order_id, plant_id,
            required_date, scheduled_start, scheduled_end, created_by, notes)
         VALUES (?, ?, 'manufacturing', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // A draft follows the plan — a time typed over, a quantity changed. Once
    // deployed, the tasks keep what they were deployed with.
    if (mo.status === MO_STATUS.DRAFT) await syncUnstartedTasks(conn, companyId, orderId);

    // Claim every make task on this sales order. A task whose item is bought in
    // is not production work and is left alone.
    const [claim] = await conn.query(
      `UPDATE fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
          SET t.production_order_id = ?
        WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
          AND COALESCE(i.procurement_type, ?) = 'make'
          -- Cutting belongs to the cutting order. Without this the fabrication
          -- order claims the blanks too and the two documents overlap.
          AND ${NOT_A_BLANK('i')}
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

/** Which tasks a production order owns: blanks for cutting, everything else made for fabrication. */
const claimFilter = (purpose) => (purpose === 'cutting' ? IS_A_BLANK('i') : NOT_A_BLANK('i'));

/** Write many values in a few statements rather than one round trip each. */
async function updateInChunks(conn, table, column, pairs, companyId) {
  for (let i = 0; i < pairs.length; i += 200) {
    const chunk = pairs.slice(i, i + 200);
    const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
    await conn.query(
      `UPDATE ${table} SET ${column} = CASE id ${cases} END WHERE company_id = ? AND id IN (?)`,
      [...chunk.flat(), companyId, chunk.map(([id]) => id)],
    );
  }
}

/**
 * DEPLOY a production order to the shop: draft → waiting, codes written.
 *
 * The one transition a person makes. Before it, the order is a plan — times can
 * be typed over and the tasks follow. Deploying fixes it:
 *
 *   1. the tasks are brought up to date one last time and claimed;
 *   2. every BOM row gets its code, from the code generator's 'order_item'
 *      rule (a blank already has its code — the 'blank' rule gave it one);
 *   3. every task gets its code, from the 'task' rule: the row's code, the
 *      step, the operation;
 *   4. the order moves to waiting, and from there follows the shop floor.
 *
 * CODES ARE WRITTEN ONCE. A row that already has a code keeps it — by the time
 * one exists it may be on a drawing.
 *
 * Works for both production orders; the cutting one owns the blank rows, the
 * fabrication one owns the rest.
 */
export async function deployProductionOrder(companyId, productionOrderId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[mo]] = await conn.query(
      `SELECT id, status, mo_purpose AS purpose, source_order_id AS salesId FROM fab_orders
        WHERE id = ? AND company_id = ? AND order_type = 'manufacturing' AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [productionOrderId, companyId],
    );
    if (!mo) { const e = new Error('Production order not found'); e.status = 404; throw e; }
    if (mo.status === MO_STATUS.CANCELLED) { const e = new Error('That production order is cancelled'); e.status = 409; throw e; }
    if (mo.status !== MO_STATUS.DRAFT) {
      // Already deployed. Not an error — re-reading where it stands is useful.
      await conn.rollback();
      return rollUpProductionOrder(pool, companyId, productionOrderId);
    }

    // 1. last refresh, then claim what is this order's
    await materializeOrderTasks(conn, companyId, mo.salesId);
    await syncUnstartedTasks(conn, companyId, mo.salesId);
    await conn.query(
      `UPDATE fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
          SET t.production_order_id = ?
        WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
          AND COALESCE(i.procurement_type, ?) = 'make' AND ${claimFilter(mo.purpose)}`,
      [mo.id, companyId, mo.salesId, DEFAULT_PROCUREMENT],
    );

    // 2. row codes — fabrication only; blanks were coded when they were made
    if (mo.purpose !== 'cutting') {
      const codes = await orderRowCodes(companyId, mo.salesId, conn);
      const seen = new Map();
      for (const [id, code] of codes) {
        if (seen.has(code)) {
          const e = new Error(`Two BOM rows would get the code ${code}. `
            + 'Add a position to the BOM row rule in Code Generation so rows of the same item are numbered.');
          e.status = 422; throw e;
        }
        seen.set(code, id);
      }
      const [uncoded] = codes.size
        ? await conn.query(
          `SELECT id FROM fab_items WHERE company_id = ? AND id IN (?) AND code IS NULL`,
          [companyId, [...codes.keys()]],
        )
        : [[]];
      try {
        await updateInChunks(conn, 'fab_items', 'code',
          uncoded.map((r) => [Number(r.id), codes.get(Number(r.id))]), companyId);
      } catch (err) {
        if (err?.code !== 'ER_DUP_ENTRY') throw err;
        const e = new Error('A BOM row code is already used by another item. Change the BOM row rule in Code Generation and deploy again.');
        e.status = 409; throw e;
      }
    }

    // 3. task codes
    const [tasks] = await conn.query(
      `SELECT t.id, t.item_id AS itemId, t.seq_no AS seqNo, i.code AS rowCode, o.code AS operationCode
         FROM fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id
         LEFT JOIN fab_operations o ON o.id = t.operation_id
        WHERE t.company_id = ? AND t.production_order_id = ? AND t.deleted_at IS NULL`,
      [companyId, mo.id],
    );
    // Step number = position down the row's flow, 1, 2, 3 — the same count the
    // production-order screen shows.
    const byRow = new Map();
    for (const t of tasks) { if (!byRow.has(t.itemId)) byRow.set(t.itemId, []); byRow.get(t.itemId).push(t); }
    for (const list of byRow.values()) list.sort((a, b) => a.seqNo - b.seqNo).forEach((t, i) => { t.stepNo = i + 1; });
    const tcodes = await taskCodes(companyId, tasks);
    await updateInChunks(conn, 'fab_project_tasks', 'task_code',
      tasks.map((t, i) => [Number(t.id), tcodes[i]]), companyId);

    // 4. deployed
    await conn.query(
      `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ?`,
      [MO_STATUS.WAITING, mo.id, companyId],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
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

