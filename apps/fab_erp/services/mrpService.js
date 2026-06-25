/**
 * mrpService.js
 * -------------
 * Material Requirements Planning engine for fab_erp.
 *
 * Algorithm (single company, one run):
 *   1. Delete previous MRP-generated draft planned orders (type = 'mrp_make' | 'mrp_buy').
 *   2. Collect gross demand from open sales order lines.
 *   3. Add reorder-point demand from stock policies (where on_hand < min_qty).
 *   4. BFS BOM explosion — for each demand item:
 *        a. Subtract available stock (on_hand + on_order) → net requirement.
 *        b. Look up procurement_type and lead_time_days.
 *        c. Create a Planned Order (order_type='planned', type='mrp_make'|'mrp_buy').
 *        d. If make item: add BOM components to the work queue (scaled to net qty).
 *   5. Insert all planned orders in a single transaction.
 *   6. Update the fab_mrp_runs log.
 *
 * Exported:
 *   runMrp(companyId, options?)  → { runId, created, deleted }
 *   getMrpRuns(companyId, limit) → run log rows
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const MAX_BOM_DEPTH = 8;

// ── Public: run MRP for one company ──────────────────────────────────────────

export async function runMrp(companyId, { triggeredBy = 'manual', userId = null } = {}) {
  const conn = await pool.getConnection();

  const [runRes] = await conn.query(
    `INSERT INTO fab_mrp_runs (company_id, triggered_by, triggered_by_user_id, status)
     VALUES (?, ?, ?, 'running')`,
    [companyId, triggeredBy, userId ?? null],
  );
  const runId = runRes.insertId;

  let created = 0;
  let deleted = 0;

  try {
    await conn.beginTransaction();

    // ── 1. Clear previous MRP planned orders (lines first, then headers) ──────
    // Delete lines first — no CASCADE on the FK so we must do it manually.
    await conn.query(
      `DELETE fol FROM fab_order_lines fol
       JOIN fab_orders fo ON fo.id = fol.order_id
       WHERE fo.company_id = ?
         AND fo.order_type = 'planned'
         AND fo.type IN ('mrp_make', 'mrp_buy')
         AND fo.status = 'draft'
         AND fo.deleted_at IS NULL`,
      [companyId],
    );

    const [delRes] = await conn.query(
      `DELETE FROM fab_orders
       WHERE company_id = ?
         AND order_type = 'planned'
         AND type IN ('mrp_make', 'mrp_buy')
         AND status = 'draft'
         AND deleted_at IS NULL`,
      [companyId],
    );
    deleted = delRes.affectedRows;

    // ── 2. Gross demand from open sales order lines ───────────────────────────
    const [demandRows] = await conn.query(
      `SELECT fol.catalog_item_id,
              SUM(fol.qty - COALESCE(fol.qty_completed, 0)) AS gross_qty,
              MIN(fo.required_date)                          AS earliest_required,
              MIN(fo.id)                                     AS source_order_id,
              MIN(fol.id)                                    AS source_order_line_id
       FROM fab_order_lines fol
       JOIN fab_orders fo ON fol.order_id = fo.id
       WHERE fo.company_id = ?
         AND fo.order_type = 'sales'
         AND fo.status NOT IN ('closed', 'cancelled', 'shipped')
         AND fo.deleted_at IS NULL
         AND fol.deleted_at IS NULL
         AND fol.catalog_item_id IS NOT NULL
       GROUP BY fol.catalog_item_id`,
      [companyId],
    );

    // ── 3. Reorder-point demand from stock policies ───────────────────────────
    const [policyRows] = await conn.query(
      `SELECT fsp.catalog_item_id,
              GREATEST(0, fsp.reorder_qty) AS reorder_qty
       FROM fab_stock_policies fsp
       LEFT JOIN (
         SELECT catalog_item_id, SUM(qty_on_hand) AS on_hand
           FROM fab_stock_balances
          WHERE company_id = ? AND deleted_at IS NULL
          GROUP BY catalog_item_id
       ) sb ON sb.catalog_item_id = fsp.catalog_item_id
       WHERE fsp.company_id = ? AND fsp.deleted_at IS NULL
         AND fsp.min_qty > COALESCE(sb.on_hand, 0)`,
      [companyId, companyId],
    );

    // Merge into demand map
    const demandMap = new Map(); // catalogItemId → { qty, requiredDate, sourceOrderId, sourceOrderLineId }
    for (const r of demandRows) {
      const qty = Number(r.gross_qty);
      if (qty > 0) {
        demandMap.set(r.catalog_item_id, {
          qty,
          requiredDate: r.earliest_required,
          sourceOrderId: r.source_order_id,
          sourceOrderLineId: r.source_order_line_id,
        });
      }
    }
    for (const r of policyRows) {
      const extra = Number(r.reorder_qty);
      if (extra <= 0) continue;
      const existing = demandMap.get(r.catalog_item_id);
      if (existing) {
        existing.qty += extra;
      } else {
        demandMap.set(r.catalog_item_id, {
          qty: extra,
          requiredDate: null,
          sourceOrderId: null,
          sourceOrderLineId: null,
        });
      }
    }

    if (demandMap.size === 0) {
      await conn.commit();
      await conn.query(
        `UPDATE fab_mrp_runs
         SET status='success', finished_at=NOW(),
             planned_orders_created=0, planned_orders_deleted=?
         WHERE id=?`,
        [deleted, runId],
      );
      conn.release();
      return { runId, created: 0, deleted };
    }

    // ── 4. Stock snapshot ─────────────────────────────────────────────────────
    const [stockRows] = await conn.query(
      `SELECT catalog_item_id,
              SUM(qty_on_hand) AS on_hand,
              SUM(qty_ordered) AS on_order
       FROM fab_stock_balances
       WHERE company_id = ? AND deleted_at IS NULL
       GROUP BY catalog_item_id`,
      [companyId],
    );
    const stockMap = new Map();
    for (const r of stockRows) {
      stockMap.set(r.catalog_item_id, {
        onHand: Number(r.on_hand),
        onOrder: Number(r.on_order),
      });
    }

    // ── 5. Item catalog snapshot (procurement_type, lead_time_days) ───────────
    const [itemRows] = await conn.query(
      `SELECT id, procurement_type, lead_time_days, mrp_active
       FROM fab_item_catalog
       WHERE company_id = ? AND deleted_at IS NULL`,
      [companyId],
    );
    const itemMap = new Map();
    for (const r of itemRows) {
      itemMap.set(r.id, {
        procurementType: r.procurement_type || 'buy',
        leadTimeDays: Number(r.lead_time_days) || 1,
        mrpActive: r.mrp_active === 1,
      });
    }

    // ── 6. Default BOM snapshot ───────────────────────────────────────────────
    const [bomRows] = await conn.query(
      `SELECT fmb.id          AS bom_id,
              fmb.catalog_item_id,
              fmb.base_qty,
              fmbi.ref_catalog_item_id AS component_id,
              fmbi.qty                 AS component_qty
       FROM fab_material_boms fmb
       JOIN fab_material_bom_items fmbi ON fmbi.bom_id = fmb.id
       WHERE fmb.company_id = ?
         AND fmb.is_default = 1
         AND fmb.deleted_at IS NULL
         AND fmbi.deleted_at IS NULL`,
      [companyId],
    );
    const bomMap = new Map(); // catalogItemId → { bomId, baseQty, components[] }
    for (const r of bomRows) {
      if (!bomMap.has(r.catalog_item_id)) {
        bomMap.set(r.catalog_item_id, {
          bomId: r.bom_id,
          baseQty: Number(r.base_qty) || 1,
          components: [],
        });
      }
      bomMap.get(r.catalog_item_id).components.push({
        componentId: r.component_id,
        componentQty: Number(r.component_qty),
      });
    }

    // ── 7. BFS BOM explosion ──────────────────────────────────────────────────
    // parentSeqIdx: 0-based index in ordersToCreate of the parent planned order.
    // Since BFS visits parents before children and we insert in BFS order,
    // insertedIds[parentSeqIdx] will always be resolved before we need it.
    const workQueue = [];
    for (const [itemId, d] of demandMap) {
      workQueue.push({
        catalogItemId:    itemId,
        qty:              d.qty,
        requiredDate:     d.requiredDate,
        depth:            0,
        sourceOrderId:    d.sourceOrderId,
        sourceOrderLineId: d.sourceOrderLineId,
        parentSeqIdx:     null,   // top-level demand has no parent planned order
      });
    }

    const ordersToCreate = [];
    let seq = 0;
    const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    while (workQueue.length > 0) {
      const { catalogItemId, qty, requiredDate, depth, sourceOrderId, sourceOrderLineId, parentSeqIdx } =
        workQueue.shift();

      if (depth > MAX_BOM_DEPTH) continue;

      const item = itemMap.get(catalogItemId);
      if (!item || !item.mrpActive) continue;

      // Net requirement after subtracting available stock
      const stock = stockMap.get(catalogItemId) ?? { onHand: 0, onOrder: 0 };
      const netQty = qty - stock.onHand - stock.onOrder;
      if (netQty <= 0) continue;

      // Scheduling
      const reqDate   = requiredDate ? new Date(requiredDate) : addDays(new Date(), 7);
      const startDate = addDays(reqDate, -item.leadTimeDays);

      const bom   = bomMap.get(catalogItemId);
      const bomId = bom?.bomId ?? null;

      const mySeqIdx = ordersToCreate.length; // 0-based index of this order
      seq++;
      ordersToCreate.push({
        company_id:            companyId,
        order_number:          `PLN-${datePrefix}-${String(seq).padStart(4, '0')}`,
        order_type:            'planned',
        type:                  item.procurementType === 'make' ? 'mrp_make' : 'mrp_buy',
        status:                'draft',
        catalog_item_id:       catalogItemId,
        qty:                   roundQty(netQty),
        required_date:         toDateStr(reqDate),
        scheduled_start:       toDateTimeStr(startDate),
        scheduled_end:         toDateTimeStr(reqDate),
        bom_id:                bomId,
        source_order_id:       sourceOrderId,
        source_order_line_id:  sourceOrderLineId,
        parentSeqIdx,          // resolved to a real DB id during INSERT
      });

      // Explode BOM for make items — children get this order as their parent
      if (item.procurementType === 'make' && bom) {
        for (const comp of bom.components) {
          const compQty = (comp.componentQty / bom.baseQty) * netQty;
          workQueue.push({
            catalogItemId:     comp.componentId,
            qty:               compQty,
            requiredDate:      toDateStr(startDate),
            depth:             depth + 1,
            sourceOrderId,
            sourceOrderLineId,
            parentSeqIdx:      mySeqIdx,  // this order is the parent
          });
        }
      }
    }

    // ── 8. Insert planned orders + one line each ─────────────────────────────
    // insertedIds[i] = DB id of ordersToCreate[i] — used to resolve parent_planned_order_id
    const insertedIds = [];

    for (const o of ordersToCreate) {
      const parentPlannedOrderId =
        o.parentSeqIdx !== null ? (insertedIds[o.parentSeqIdx] ?? null) : null;

      const [orderRes] = await conn.query(
        `INSERT INTO fab_orders
           (company_id, order_number, order_type, type, status, catalog_item_id, qty,
            required_date, scheduled_start, scheduled_end, bom_id,
            source_order_id, source_order_line_id, parent_planned_order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          o.company_id, o.order_number, o.order_type, o.type, o.status,
          o.catalog_item_id, o.qty, o.required_date,
          o.scheduled_start, o.scheduled_end, o.bom_id,
          o.source_order_id, o.source_order_line_id,
          parentPlannedOrderId,
        ],
      );

      insertedIds.push(orderRes.insertId);

      // Each planned order gets exactly one line representing the planned item
      await conn.query(
        `INSERT INTO fab_order_lines
           (company_id, order_id, line_no, catalog_item_id, qty, status,
            bom_id, scheduled_start, scheduled_end)
         VALUES (?, ?, 1, ?, ?, 'draft', ?, ?, ?)`,
        [
          o.company_id, orderRes.insertId,
          o.catalog_item_id, o.qty,
          o.bom_id, o.scheduled_start, o.scheduled_end,
        ],
      );

      created++;
    }

    await conn.commit();

    await conn.query(
      `UPDATE fab_mrp_runs
       SET status='success', finished_at=NOW(),
           planned_orders_created=?, planned_orders_deleted=?
       WHERE id=?`,
      [created, deleted, runId],
    );

    logger.info({ companyId, runId, created, deleted }, '[mrp] run complete');
    return { runId, created, deleted };

  } catch (err) {
    await conn.rollback().catch(() => {});
    logger.error({ err, companyId, runId }, '[mrp] run failed');
    await conn.query(
      `UPDATE fab_mrp_runs
       SET status='error', finished_at=NOW(), error_message=?
       WHERE id=?`,
      [err.message?.slice(0, 500), runId],
    ).catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ── Public: fetch run history ─────────────────────────────────────────────────

export async function getMrpRuns(companyId, limit = 20) {
  const [rows] = await pool.query(
    `SELECT id, triggered_by, triggered_by_user_id, started_at, finished_at,
            status, planned_orders_created, planned_orders_deleted, error_message
     FROM fab_mrp_runs
     WHERE company_id = ?
     ORDER BY started_at DESC
     LIMIT ?`,
    [companyId, limit],
  );
  return rows;
}

// ── Public: per-company MRP settings ─────────────────────────────────────────

export async function getMrpSettings(companyId) {
  const [rows] = await pool.query(
    `SELECT auto_run_enabled, run_hour, run_minute, last_auto_run_date
     FROM fab_mrp_settings
     WHERE company_id = ?`,
    [companyId],
  );
  // Return defaults if no row yet
  return rows[0] ?? { auto_run_enabled: 1, run_hour: 23, run_minute: 0, last_auto_run_date: null };
}

export async function saveMrpSettings(companyId, { autoRunEnabled, runHour, runMinute }) {
  await pool.query(
    `INSERT INTO fab_mrp_settings (company_id, auto_run_enabled, run_hour, run_minute)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       auto_run_enabled = VALUES(auto_run_enabled),
       run_hour         = VALUES(run_hour),
       run_minute       = VALUES(run_minute)`,
    [companyId, autoRunEnabled ? 1 : 0, runHour, runMinute],
  );
}

// Used by the cron scheduler to record today's run and avoid double-running
export async function markAutoRun(companyId, today) {
  await pool.query(
    `INSERT INTO fab_mrp_settings (company_id, last_auto_run_date)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_auto_run_date = VALUES(last_auto_run_date)`,
    [companyId, today],
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

function toDateTimeStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

function roundQty(n) {
  return Math.round(n * 10000) / 10000;
}
