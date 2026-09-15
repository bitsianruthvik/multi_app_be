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
import { materializeOrderTasks, syncUnstartedTasks, planOrderTasks } from './taskGatingService.js';
import { generateCode, orderRowCodes, taskCodes, pieceCodes } from './codegenService.js';

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

    // FOR UPDATE on the sales order row: two requests to raise this order's
    // production order at once must serialize here, not race the SELECT below
    // and both decide "no MO yet" before either has inserted one. EU-1's
    // `uq_fo_mo_source_active` is the backstop for any path that reaches the
    // INSERT without this lock — handled via ER_DUP_ENTRY just below.
    const [[sales]] = await conn.query(
      `SELECT id, order_number, required_date, plant_id, scheduled_start, scheduled_end
         FROM fab_orders
        WHERE id = ? AND company_id = ? AND order_type = 'sales' AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [orderId, companyId],
    );
    if (!sales) {
      // The 'sales' filter above also excludes a quote — tell the caller why,
      // rather than reporting a quote pointing at Production as "not found".
      const [[any]] = await conn.query(
        `SELECT order_type FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [orderId, companyId],
      );
      if (any?.order_type === 'quote') {
        const e = new Error('This is a quote. Convert it to a sales order before raising production.');
        e.status = 409; e.code = 'QUOTE_CANNOT_RAISE'; throw e;
      }
      const e = new Error('Sales order not found'); e.status = 404; throw e;
    }

    const findExisting = () => conn.query(
      `SELECT id, order_number, status FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing' AND mo_purpose IS NULL
          AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [companyId, orderId],
    ).then(([[r]]) => r);

    let mo = await findExisting();
    let created = false;
    if (!mo) {
      const orderNumber = await generateCode(companyId, 'manufacturing_order', {}, conn);
      try {
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
      } catch (err) {
        if (err?.code !== 'ER_DUP_ENTRY') throw err;
        // The lock above should make this unreachable in practice; kept as the
        // backstop the unique key exists for — re-read rather than error.
        mo = await findExisting();
        if (!mo) throw err;
      }
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

/**
 * Claim every make task on a sales order to whichever production order(s) it
 * already has — the same claim UPDATE `ensureProductionOrder`/
 * `deployProductionOrder` run, generalized across ALL of the order's live
 * MOs (cutting and fabrication both, when both exist) rather than just one.
 *
 * EU-12's re-materialization needs this: `applyRematerialize` rebuilds the
 * order's unstarted tasks with brand-new ids that start life unclaimed, and
 * without this they never rejoin the production order(s) that already exist
 * for the order — `rollUpProductionOrder` would then count zero tasks for
 * work the shop can plainly see.
 *
 * @returns {Promise<{claimed: number, productionOrders: number[]}>}
 */
export async function claimTasksForOrder(conn, companyId, orderId) {
  const [mos] = await conn.query(
    `SELECT id, mo_purpose AS purpose FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND status <> ? AND deleted_at IS NULL`,
    [companyId, orderId, MO_STATUS.CANCELLED],
  );
  let claimed = 0;
  for (const mo of mos) {
    const [claim] = await conn.query(
      `UPDATE fab_project_tasks t
         JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
          SET t.production_order_id = ?
        WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
          AND COALESCE(i.procurement_type, ?) = 'make' AND ${claimFilter(mo.purpose)}
          AND (t.production_order_id IS NULL OR t.production_order_id <> ?)`,
      [mo.id, companyId, orderId, DEFAULT_PROCUREMENT, mo.id],
    );
    claimed += claim?.affectedRows ?? 0;
  }
  return { claimed, productionOrders: mos.map((mo) => Number(mo.id)) };
}

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
 * A cheap proxy for "would re-planning this order produce a different plan
 * than the one already computed" — max `updated_at` over the order's items and
 * over the flow steps any of those items actually reference. Not exact (a note
 * typed on an unrelated step still bumps it), but wrong only in the safe
 * direction: an unnecessary retry, never a stale plan written as if fresh.
 */
async function planFingerprint(exec, companyId, orderId) {
  const [[row]] = await exec.query(
    `SELECT
        (SELECT COALESCE(MAX(updated_at), '1970-01-01 00:00:00') FROM fab_items
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL) AS itemsMax,
        (SELECT COALESCE(MAX(s.updated_at), '1970-01-01 00:00:00') FROM fab_operation_flow_steps s
          WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.flow_id IN (
            SELECT DISTINCT flow_id FROM fab_items
             WHERE company_id = ? AND order_id = ? AND flow_id IS NOT NULL AND deleted_at IS NULL
          )) AS stepsMax,
        (SELECT COUNT(*) FROM fab_project_tasks
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL) AS taskCount`,
    [companyId, orderId, companyId, companyId, orderId, companyId, orderId],
  );
  // taskCount catches what itemsMax/stepsMax can't: two MOs on the same sales
  // order both inserting missing tasks (materializeOrderTasks) with no unique
  // key on (item_id, flow_step_id) — a fingerprint blind to the task table
  // itself would call that a no-op change and skip the retry.
  return `${row.itemsMax}|${row.stepsMax}|${row.taskCount}`;
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
 *
 * REDEPLOY (EU-12): a revision on a CONFIRMED order can add BOM rows and
 * tasks to a production order that was deployed long ago. `opts.redeploy`
 * lets this run again past the `status !== draft` gate that normally makes
 * deploying a one-way trip, taking the SAME lock and SAME re-plan-under-lock
 * discipline. It never forces the order back to `waiting` — step 4 below only
 * writes that status from `draft`; an already-active or -done MO keeps its
 * own status, recomputed honestly by `rollUpProductionOrder` at the end from
 * the tasks it now owns.
 */
export async function deployProductionOrder(companyId, productionOrderId, opts = {}) {
  const { redeploy = false } = opts;
  // Which sales order this is, read without any lock — just enough to plan
  // against. A full re-plan is thousands of rows on a real order; computing it
  // BEFORE taking FOR UPDATE below means that work never holds the row locked
  // against every other reader of this document while it runs.
  const [[lookup]] = await pool.query(
    `SELECT id, status, source_order_id AS salesId FROM fab_orders
      WHERE id = ? AND company_id = ? AND order_type = 'manufacturing' AND deleted_at IS NULL LIMIT 1`,
    [productionOrderId, companyId],
  );
  if (!lookup) { const e = new Error('Production order not found'); e.status = 404; throw e; }
  if (lookup.status === MO_STATUS.CANCELLED) { const e = new Error('That production order is cancelled'); e.status = 409; throw e; }
  if (lookup.status !== MO_STATUS.DRAFT && !redeploy) return rollUpProductionOrder(pool, companyId, productionOrderId);

  let precomputed = await planOrderTasks(pool, companyId, lookup.salesId, { evaluateExisting: true });
  let fingerprint = await planFingerprint(pool, companyId, lookup.salesId);

  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Two MOs raised off the SAME sales order (cutting + fabrication) can
      // deploy concurrently; each only locked its own MO row, so both could
      // pass the fingerprint check and both call materializeOrderTasks for
      // the sales order at once — no unique key on (item_id, flow_step_id)
      // stops the double insert. Locking the sales order row itself serializes
      // every MO under it through this one point before either re-validates.
      await conn.query(
        `SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL
          LIMIT 1 FOR UPDATE`,
        [lookup.salesId, companyId],
      );
      const [[mo]] = await conn.query(
        `SELECT id, status, mo_purpose AS purpose, source_order_id AS salesId FROM fab_orders
          WHERE id = ? AND company_id = ? AND order_type = 'manufacturing' AND deleted_at IS NULL
          LIMIT 1 FOR UPDATE`,
        [productionOrderId, companyId],
      );
      if (!mo) { const e = new Error('Production order not found'); e.status = 404; throw e; }
      if (mo.status === MO_STATUS.CANCELLED) { const e = new Error('That production order is cancelled'); e.status = 409; throw e; }
      if (mo.status !== MO_STATUS.DRAFT && !redeploy) {
        // Already deployed. Not an error — re-reading where it stands is useful.
        await conn.rollback();
        return rollUpProductionOrder(pool, companyId, productionOrderId);
      }

      // The plan above was computed before this lock, so it may be stale by
      // the time the lock lands. Re-check the cheap fingerprint rather than
      // trusting it blindly or paying for a second full re-plan under the lock
      // as a matter of course; recompute and retry ONCE if it moved.
      const freshFingerprint = await planFingerprint(conn, companyId, mo.salesId);
      if (freshFingerprint !== fingerprint) {
        await conn.rollback();
        if (attempt === 0) {
          precomputed = await planOrderTasks(pool, companyId, mo.salesId, { evaluateExisting: true });
          fingerprint = await planFingerprint(pool, companyId, mo.salesId);
          continue;
        }
        const e = new Error('This order changed while it was deploying. Try again.');
        e.status = 409; throw e;
      }

      // 1. last refresh, then claim what is this order's — using the plan
      //    computed above, not recomputed a second time under the lock.
      await materializeOrderTasks(conn, companyId, mo.salesId, { precomputed });
      await syncUnstartedTasks(conn, companyId, mo.salesId, { precomputed });
      await conn.query(
        `UPDATE fab_project_tasks t
           JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
            SET t.production_order_id = ?
          WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
            AND COALESCE(i.procurement_type, ?) = 'make' AND ${claimFilter(mo.purpose)}`,
        [mo.id, companyId, mo.salesId, DEFAULT_PROCUREMENT],
      );

      await deployRowsAndTaskCodes(conn, companyId, mo);

      // 4. deployed — only a draft actually MOVES here. A redeploy on an
      // already-active or -done MO leaves its status alone; rollUpProductionOrder
      // below recomputes it honestly from the tasks it owns now, which may
      // still be `in_progress`/`done` even after new work was added.
      if (mo.status === MO_STATUS.DRAFT) {
        await conn.query(
          `UPDATE fab_orders SET status = ? WHERE id = ? AND company_id = ?`,
          [MO_STATUS.WAITING, mo.id, companyId],
        );
      }
      await conn.commit();
      break;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return rollUpProductionOrder(pool, companyId, productionOrderId);
}

/** Steps 2-3 of deploying, split out only so the retry loop above stays readable. */
async function deployRowsAndTaskCodes(conn, companyId, mo) {
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

    /*
     * 2b. PIECE IDENTITIES. Every made row with a quantity above one gets a
     * name per piece (codegenService.pieceCodes) — the row stays one row and
     * one task. INSERT IGNORE on (item, seq): a re-deploy after the quantity
     * grew adds the new pieces and never renumbers the ones already painted
     * on steel; a quantity that shrank keeps its extra names, like marks do.
     */
    if (codes.size) {
      const [qtys] = await conn.query(
        `SELECT id, qty, code FROM fab_items WHERE company_id = ? AND id IN (?) AND code IS NOT NULL`,
        [companyId, [...codes.keys()]],
      );
      const pieces = [];
      for (const r of qtys) {
        pieceCodes(r.code, r.qty).forEach((code, i) => pieces.push([companyId, mo.salesId, Number(r.id), i + 1, code]));
      }
      for (let i = 0; i < pieces.length; i += 500) {
        await conn.query(
          `INSERT IGNORE INTO fab_order_pieces (company_id, order_id, item_id, seq, code) VALUES ?`,
          [pieces.slice(i, i + 500)],
        );
      }
    }
  }

  // 3. task codes
  await issueTaskCodes(conn, companyId, mo.id);
}

/**
 * Step 3 of deploying, on its own so EU-12's re-materialization can re-run it
 * for a production order that already exists (a fresh revision's tasks arrive
 * uncoded even though the MO around them was deployed long ago) without
 * pulling in step 2's row-coding, which only makes sense at first deploy.
 *
 * Recomputes every task's code under this production order, not just the
 * uncoded ones — `taskCodes` is deterministic from the row's own code, the
 * step and the operation, so a task that already has the right code is
 * written the same value it already had.
 */
export async function issueTaskCodes(conn, companyId, productionOrderId) {
  const [tasks] = await conn.query(
    `SELECT t.id, t.item_id AS itemId, t.seq_no AS seqNo, i.code AS rowCode, o.code AS operationCode
       FROM fab_project_tasks t
       JOIN fab_items i ON i.id = t.item_id
       LEFT JOIN fab_operations o ON o.id = t.operation_id
      WHERE t.company_id = ? AND t.production_order_id = ? AND t.deleted_at IS NULL`,
    [companyId, productionOrderId],
  );
  // Step number = position down the row's flow, 1, 2, 3 — the same count the
  // production-order screen shows.
  const byRow = new Map();
  for (const t of tasks) { if (!byRow.has(t.itemId)) byRow.set(t.itemId, []); byRow.get(t.itemId).push(t); }
  for (const list of byRow.values()) list.sort((a, b) => a.seqNo - b.seqNo).forEach((t, i) => { t.stepNo = i + 1; });
  const tcodes = await taskCodes(companyId, tasks);
  await updateInChunks(conn, 'fab_project_tasks', 'task_code',
    tasks.map((t, i) => [Number(t.id), tcodes[i]]), companyId);
  return { coded: tasks.length };
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

