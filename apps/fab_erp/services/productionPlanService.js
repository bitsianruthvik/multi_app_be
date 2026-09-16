/**
 * productionPlanService.js — the production step of an order, as one read.
 *
 * Three things on one screen, because they are three answers to one question —
 * how does this order get built:
 *
 *   BUY          what is bought in, what the shelf holds, what is asked for
 *   CUTTING      the production order that cuts plate into blanks
 *   FABRICATION  the production order that makes everything else
 *
 * Each production order is shown as its BOM turned into a table — one row per
 * BOM row, in BOM order — with the row's flow laid out beside it step by step.
 * Every step shows the time worked out for it, and the time can be typed over.
 *
 * NOTHING HERE WORKS OUT A TIME. The steps and their times come from
 * taskGatingService.planOrderTasks, the same call that builds the tasks, so
 * what this screen shows is what the tasks get. Codes come from the code
 * generator: the BOM row codes and task codes are shown before they are saved
 * (they are derived, so the preview IS the code) and written when the
 * production order is deployed.
 */

import { pool } from '../../../db.js';
import { planOrderTasks, syncUnstartedTasks, materializeOrderTasks } from './taskGatingService.js';
import { orderRowCodeRanges, taskCodes } from './codegenService.js';
import { orderShortfall } from './procurementService.js';
import { onOrderByItem, heldByOrder, procurementForOrder } from './procurementOrderService.js';
import { ensureProductionOrder } from './productionOrderService.js';
import { ensureCuttingOrder } from './blankService.js';
import { staleProductionOrders } from './deploySignatureService.js';

/**
 * EU-9 item 4: a per-call memo so a screen that reads several procurement
 * figures at once — `orderShortfall` alone joins half a dozen tables — does
 * not compute the same one twice. `buyView` is this file's only caller today,
 * so the cache never actually gets a second hit yet; it exists so a future
 * caller that also needs the shortfall (a combined confirm+buy action, say)
 * has somewhere to share it rather than adding a fourth copy of the query.
 *
 * EU-14 item E3: the memoization itself now lives in `procurementService.js`
 * (`orderShortfall`/`orderProcurementSplit` both take `{ctx}` and cache into
 * `ctx.cache` under their own keys) so the SAME `{cache: Map}` shape can be
 * shared with `orderReadinessService.summariseProcurement` and
 * `procurementOrderService.requestProcurement` when a caller further up
 * builds one ctx and hands it to more than one of the three. This file's own
 * `ctx` object is unchanged — it already had a `cache` Map — `shortfallFor`
 * just stopped keeping its own copy of the answer.
 */
function procurementCtx(companyId, orderId, conn) {
  return { companyId, orderId, conn, cache: new Map() };
}

async function shortfallFor(ctx) {
  return orderShortfall(ctx.companyId, ctx.orderId, ctx.conn, { ctx });
}

const minutes = (h) => (h == null ? null : Math.round(Number(h) * 60 * 100) / 100);

/**
 * Both production orders of a sales order, by purpose.
 *
 * @param {boolean} [forUpdate=false] lock both rows — for a caller about to
 *   decide, in the SAME transaction, whether a status still allows a write
 *   (setStepTime's TOCTOU fix: reading status before BEGIN let a deploy race
 *   land between the check and the write).
 */
async function productionOrders(companyId, orderId, exec = pool, forUpdate = false) {
  const [rows] = await exec.query(
    `SELECT id, order_number AS orderNumber, status, mo_purpose AS purpose, progress_pct AS progressPct, notes
       FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND deleted_at IS NULL AND status <> 'cancelled'
      ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`,
    [companyId, orderId],
  );
  return {
    cutting: rows.find((r) => r.purpose === 'cutting') ?? null,
    fabrication: rows.find((r) => r.purpose == null) ?? null,
  };
}

/**
 * The whole production step for one sales order — or a quote's read-only
 * estimate of the same (EU-13/PLAN.md: "the figures are real, but nothing
 * here can be raised or bought" — `isEstimate` on the FE just disables the
 * write actions; the figures themselves must still be computed).
 */
export async function productionPlan(companyId, orderId) {
  const [[order]] = await pool.query(
    `SELECT id, order_number AS orderNumber FROM fab_orders
      WHERE id = ? AND company_id = ? AND order_type IN ('sales', 'quote') AND deleted_at IS NULL`,
    [orderId, companyId],
  );
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const [{ planned }, [rows], [tasks], mos, rowCodePreview] = await Promise.all([
    planOrderTasks(pool, companyId, orderId, { evaluateExisting: true }),
    pool.query(
      `SELECT i.id, i.parent_item_id AS parentId, i.name, i.qty, i.code, i.flow_id AS flowId,
              COALESCE(i.procurement_type, 'make') AS procurement,
              (bc.id IS NOT NULL) AS isBlank, f.name AS flowName
         FROM fab_items i
         LEFT JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.material_form = 'blank'
         LEFT JOIN fab_operation_flows f ON f.id = i.flow_id
        WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL AND i.node_kind = 'structure'
        ORDER BY i.sort_order IS NULL, i.sort_order, i.id`,
      [companyId, orderId],
    ),
    pool.query(
      // sent_out_at/returned_at (EU-1/EU-14): only ever set on a task whose
      // operation is_subcontract, read below for the Subcontract section.
      `SELECT id, item_id AS itemId, flow_step_id AS stepId, status, task_code AS taskCode,
              sent_out_at AS sentOutAt, returned_at AS returnedAt
         FROM fab_project_tasks
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
      [companyId, orderId],
    ),
    productionOrders(companyId, orderId),
    orderRowCodeRanges(companyId, orderId),
  ]);

  const opIds = [...new Set(planned.map((t) => t.operationId))];
  const [ops] = opIds.length
    ? await pool.query(
      `SELECT id, code, name, is_subcontract AS isSubcontract, default_supplier_id AS defaultSupplierId
         FROM fab_operations WHERE company_id = ? AND id IN (?)`,
      [companyId, opIds],
    )
    : [[]];
  const opById = new Map(ops.map((o) => [Number(o.id), o]));
  const taskByKey = new Map(tasks.map((t) => [`${t.itemId}:${t.stepId}`, t]));

  // ── the rows, in BOM order, each with its depth ─────────────────────────
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const kids = new Map();
  for (const r of rows) {
    const k = r.parentId != null && byId.has(Number(r.parentId)) ? Number(r.parentId) : 'root';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(r);
  }
  const rolled = (r) => {
    let q = 1;
    for (let cur = r, hop = 0; cur && hop < 64; hop++) {
      q *= Number(cur.qty) || 0;
      cur = cur.parentId != null ? byId.get(Number(cur.parentId)) : null;
    }
    return q;
  };
  const ordered = [];
  const walk = (key, depth) => {
    for (const r of kids.get(key) ?? []) {
      ordered.push({ r, depth });
      walk(Number(r.id), depth + 1);
    }
  };
  walk('root', 0);

  const codeOf = (r) => r.code ?? rowCodePreview.get(Number(r.id))?.code ?? null;
  /** The row's last piece under one parent (SPAN1-L1-4 on a qty-4 row), or null. */
  const codeLastOf = (r) => rowCodePreview.get(Number(r.id))?.last ?? null;

  // ── steps, grouped by row ────────────────────────────────────────────────
  const stepsByItem = new Map();
  for (const t of planned) {
    if (!stepsByItem.has(t.itemId)) stepsByItem.set(t.itemId, []);
    stepsByItem.get(t.itemId).push(t);
  }
  const allSteps = [];
  for (const list of stepsByItem.values()) list.sort((a, b) => a.stepNo - b.stepNo);

  const shape = (r, depth) => {
    const qty = rolled(r);
    const steps = (stepsByItem.get(Number(r.id)) ?? []).map((t) => {
      const op = opById.get(Number(t.operationId));
      const task = taskByKey.get(`${t.itemId}:${t.stepId}`);
      const step = {
        stepId: t.stepId,
        stepNo: t.stepNo,
        operationCode: op?.code ?? null,
        operationName: op?.name ?? null,
        formulaMinutes: minutes(t.formulaHours),
        overrideMinutes: minutes(t.overrideHours),
        minutes: minutes(t.computedHours),
        setupMinutes: minutes(t.setupHours),
        totalMinutes: Math.round(((Number(t.setupHours) || 0) + (Number(t.computedHours) || 0) * qty) * 60),
        taskId: task?.id ?? null,
        status: task?.status ?? null,
        taskCode: task?.taskCode ?? null,
        // EU-8: why `minutes` is null, when it is. `null` on both means the
        // operation has no formula at all — not an error, just unconfigured.
        formulaError: t.formulaError ?? null,
        warnings: t.warnings ?? [],
        // EU-9 item 5: replaces the FE's own 0.005-minute tolerance compare
        // (OrderProductionPlan.tsx StepCar.commit) — typing the formula's own
        // number back is the same as never having typed over it at all.
        overrideIsFormula: minutes(t.overrideHours) != null && minutes(t.formulaHours) != null
          && Math.abs(minutes(t.overrideHours) - minutes(t.formulaHours)) < 0.005,
      };
      allSteps.push({ step, rowCode: codeOf(r) });
      return step;
    });
    return {
      id: Number(r.id),
      parentId: r.parentId == null ? null : Number(r.parentId),
      depth,
      name: r.name,
      qty: Number(r.qty) || 0,
      totalQty: qty,
      code: codeOf(r),
      codeLast: codeLastOf(r),
      codeSaved: r.code != null,
      procurement: r.procurement,
      flowName: r.flowName ?? null,
      steps,
      totalMinutes: steps.reduce((n, s) => n + s.totalMinutes, 0),
    };
  };

  const fabrication = ordered.filter(({ r }) => !Number(r.isBlank)).map(({ r, depth }) => shape(r, depth));
  const cutting = ordered.filter(({ r }) => Number(r.isBlank)).map(({ r }) => shape(r, 0));

  /**
   * EU-14 item 2: every PLANNED step whose operation is `is_subcontract`,
   * grouped by supplier — the Production step's Subcontract section. Read off
   * `planned` (the same taskGatingService pass every other step comes from,
   * so a step preview here matches the one under Fabrication/Cutting) rather
   * than re-querying fab_project_tasks; `taskByKey` supplies the task's own
   * id/status/sent-out/returned-at once it has actually been materialized.
   */
  const subcontractSteps = [];
  for (const t of planned) {
    const op = opById.get(Number(t.operationId));
    if (!op?.isSubcontract) continue;
    const item = byId.get(Number(t.itemId));
    if (!item) continue;
    const task = taskByKey.get(`${t.itemId}:${t.stepId}`);
    subcontractSteps.push({
      supplierId: op.defaultSupplierId ?? null,
      taskId: task?.id ?? null,
      itemId: Number(t.itemId),
      itemCode: codeOf(item),
      itemName: item.name,
      operationName: op.name ?? null,
      qty: rolled(item),
      status: task?.status ?? null,
      sentOutAt: task?.sentOutAt ?? null,
      returnedAt: task?.returnedAt ?? null,
    });
  }
  const subSupplierIds = [...new Set(subcontractSteps.map((s) => s.supplierId).filter(Boolean))];
  const [[subOrders], subSupplierRows] = await Promise.all([
    pool.query(
      `SELECT id, order_number AS orderNumber, supplier_id AS supplierId, status
         FROM fab_orders
        WHERE company_id = ? AND source_order_id = ? AND order_type = 'subcontract' AND deleted_at IS NULL
        ORDER BY id`,
      [companyId, orderId],
    ),
    subSupplierIds.length
      ? pool.query(`SELECT id, name FROM fab_suppliers WHERE company_id = ? AND id IN (?)`, [companyId, subSupplierIds])
        .then(([r]) => r)
      : Promise.resolve([]),
  ]);
  const subSupplierNameOf = new Map(subSupplierRows.map((s) => [Number(s.id), s.name]));

  /**
   * A step already raised on a subcontract order has to stop offering itself
   * on the next "Send to supplier" — otherwise the same task ships on two
   * orders. `sentOutAt` cannot answer this: it is only stamped when the task
   * is physically STARTED (Task Queue), which can be days after it was
   * requested. `fab_order_lines` carries no task id (no schema change here —
   * EU-1 owns the column), so a request is recognised the same way
   * `subcontractService.raiseSubcontractOrder` wrote it: by the
   * "operation — item name" description on the subcontract order's own
   * lines. Not the item's code too — before the fabrication MO is deployed,
   * `fab_items.code` is still NULL and `raiseSubcontractOrder` stored that
   * NULL verbatim, while this step's own `itemCode` is codegen's PREVIEW of
   * that same code — the two never match pre-deploy. Good enough within one
   * sales order, where the description pair is unique per planned step.
   */
  const subOrderIds = subOrders.map((o) => o.id);
  const [requestedLines] = subOrderIds.length
    ? await pool.query(
      `SELECT description FROM fab_order_lines WHERE order_id IN (?) AND deleted_at IS NULL`,
      [subOrderIds],
    )
    : [[]];
  const requestedKeys = new Set(requestedLines.map((l) => l.description));
  for (const s of subcontractSteps) {
    const key = `${s.operationName ?? 'Subcontract'} — ${s.itemName ?? ''}`.trim();
    s.requested = requestedKeys.has(key);
  }

  const subGroupsByKey = new Map();
  for (const s of subcontractSteps) {
    const key = s.supplierId ?? 'none';
    if (!subGroupsByKey.has(key)) subGroupsByKey.set(key, []);
    subGroupsByKey.get(key).push(s);
  }
  const subcontract = {
    groups: [...subGroupsByKey.entries()].map(([key, steps]) => ({
      supplierId: key === 'none' ? null : key,
      supplierName: key === 'none' ? null : (subSupplierNameOf.get(key) ?? null),
      steps,
    })),
    orders: subOrders.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, supplierId: o.supplierId, status: o.status,
    })),
  };

  // Task codes that have not been written yet, previewed from the 'task' rule.
  const pending = allSteps.filter((x) => !x.step.taskCode);
  const previews = await taskCodes(companyId, pending.map((x) => ({
    rowCode: x.rowCode, stepNo: x.step.stepNo, operationCode: x.step.operationCode,
  })));
  pending.forEach((x, i) => { x.step.taskCode = previews[i]; x.step.taskCodeSaved = false; });
  allSteps.filter((x) => x.step.taskCodeSaved === undefined).forEach((x) => { x.step.taskCodeSaved = true; });

  /*
   * STALE = deployed, and the BOM under it has moved since (deploySignatureService).
   * The screen turns this into a "changed since deploy" flag and a Re-deploy
   * button on any order status — a revision is not the only way a deployed
   * order's BOM changes; a length typed on the Line items step is another.
   */
  const stale = await staleProductionOrders(companyId, orderId);
  if (mos.cutting) mos.cutting.stale = stale.cutting;
  if (mos.fabrication) mos.fabrication.stale = stale.fabrication;

  const section = (list, mo) => ({
    productionOrder: mo,
    rows: list,
    stepCount: list.reduce((n, r) => n + r.steps.length, 0),
    totalMinutes: list.reduce((n, r) => n + r.totalMinutes, 0),
    editable: !mo || mo.status === 'draft',
  });

  return {
    orderId,
    orderNumber: order.orderNumber,
    buy: await buyView(companyId, orderId),
    cutting: section(cutting, mos.cutting),
    fabrication: section(fabrication, mos.fabrication),
    subcontract,
  };
}

/** The buying half: each bought item against the shelf and what is on order. */
async function buyView(companyId, orderId, ctx = procurementCtx(companyId, orderId)) {
  const [shortfall, held, onOrder, purchases, [suppliers]] = await Promise.all([
    shortfallFor(ctx),
    heldByOrder(null, companyId, orderId),
    onOrderByItem(companyId, orderId),
    procurementForOrder(companyId, orderId),
    pool.query(
      `SELECT id, name FROM fab_suppliers WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
      [companyId],
    ),
  ]);
  const heldOf = new Map(held);
  return {
    lines: [
      ...shortfall.lines.map((l) => {
        const mine = heldOf.get(l.catalogItemId) ?? 0;
        const ordered = onOrder.get(l.catalogItemId) ?? 0;
        return {
          catalogItemId: l.catalogItemId,
          code: l.code,
          name: l.name,
          unit: l.unit,
          procurementType: l.procurementType,
          required: l.required,
          // `available` counts this order's own holding as free to it — the
          // shelf this order can draw on.
          inStock: l.available,
          held: mine,
          onOrder: ordered,
          stillNeeded: Math.max(0, l.required - mine - ordered),
          // EU-9 item 5: replaces the FE's own BuySection.initialTake — take
          // whatever this order already holds, else all that is free.
          suggestedTake: mine > 0 ? mine : Math.min(l.required, l.available),
        };
      }),
      // EU-14 item 3: free-issue material rendered in the same list, tagged so
      // the FE can show "supplied by customer" and leave it out of "to buy" —
      // `stillNeeded`/`suggestedTake` are always 0, because this order never
      // buys it, whatever the shelf holds.
      ...shortfall.freeIssueLines.map((l) => ({
        catalogItemId: l.catalogItemId,
        code: l.code,
        name: l.name,
        unit: l.unit,
        procurementType: l.procurementType,
        required: l.required,
        inStock: null,
        held: 0,
        onOrder: 0,
        stillNeeded: 0,
        suggestedTake: 0,
      })),
    ],
    unmatched: shortfall.unmatched,
    purchases: purchases.map((p) => ({
      id: p.id,
      orderNumber: p.order_number,
      status: p.status,
      supplierName: p.supplier_name ?? null,
      lineCount: Number(p.line_count) || 0,
      qtyOrdered: Number(p.qty_ordered) || 0,
      qtyReceived: Number(p.qty_received) || 0,
    })),
    suppliers,
  };
}

/**
 * Type over the time of one step of one BOM row — per piece, in minutes.
 * `null` clears it and the formula's time comes back.
 *
 * Only while that row's production order is a draft (or not raised yet). Once
 * deployed, the shop is working to the times it was deployed with.
 */
export async function setStepTime(companyId, orderId, itemId, stepId, value, userId = null) {
  const [[row]] = await pool.query(
    `SELECT i.id, i.flow_id AS flowId, (bc.id IS NOT NULL) AS isBlank
       FROM fab_items i
       LEFT JOIN fab_item_catalog bc ON bc.id = i.catalog_item_id AND bc.material_form = 'blank'
      WHERE i.id = ? AND i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL`,
    [itemId, companyId, orderId],
  );
  if (!row) { const e = new Error('That row is not on this order.'); e.status = 404; throw e; }
  const [[step]] = await pool.query(
    `SELECT id FROM fab_operation_flow_steps WHERE id = ? AND company_id = ? AND flow_id = ? AND deleted_at IS NULL`,
    [stepId, companyId, row.flowId],
  );
  if (!step) { const e = new Error("That step is not in this row's flow."); e.status = 404; throw e; }

  const n = value == null || value === '' ? null : Number(value);
  if (n != null && !(Number.isFinite(n) && n >= 0)) {
    const e = new Error('A time is a number of minutes, zero or more.'); e.status = 422; throw e;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // TOCTOU fix: the MO's status used to be read before BEGIN, so a deploy
    // could land between that read and this write and both would believe they
    // won. Reading it locked, inside the same transaction the write commits
    // in, makes a concurrent deploy wait for this transaction instead.
    const mos = await productionOrders(companyId, orderId, conn, true);
    const mo = Number(row.isBlank) ? mos.cutting : mos.fabrication;
    if (mo && mo.status !== 'draft') {
      const e = new Error(`${mo.orderNumber} is deployed — its times are fixed.`); e.status = 409; throw e;
    }
    if (n == null) {
      await conn.query(
        `UPDATE fab_task_time_overrides SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND item_id = ? AND flow_step_id = ? AND deleted_at IS NULL`,
        [companyId, itemId, stepId],
      );
    } else {
      await conn.query(
        `INSERT INTO fab_task_time_overrides (company_id, order_id, item_id, flow_step_id, unit_minutes, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE unit_minutes = VALUES(unit_minutes), order_id = VALUES(order_id),
                                 updated_by = VALUES(updated_by), deleted_at = NULL`,
        [companyId, orderId, itemId, stepId, n, userId],
      );
    }
    // The draft's task, if there is one, follows at once. S4: scoped to the
    // one row edited — a re-plan of the whole order to move one step's time
    // is the exact cost this scoping exists to avoid.
    await syncUnstartedTasks(conn, companyId, orderId, { itemIds: [itemId] });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { ok: true };
}

/**
 * Raise — or bring up to date — the draft production order for cutting or for
 * fabrication.
 */
export async function raiseDraft(companyId, orderId, purpose, userId = null) {
  if (purpose === 'cutting') {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await materializeOrderTasks(conn, companyId, orderId);
      const mo = await ensureCuttingOrder(companyId, orderId, conn);
      if (mo.status === 'draft') await syncUnstartedTasks(conn, companyId, orderId);
      await conn.commit();
      return mo;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
  return ensureProductionOrder(companyId, orderId, { createdBy: userId });
}
