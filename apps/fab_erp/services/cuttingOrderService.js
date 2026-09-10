/**
 * cuttingOrderService.js — turning an accepted nesting plan into work.
 *
 * ── WHAT A CUTTING ORDER IS ──────────────────────────────────────────────────
 *
 * Plate in, blanks out. One document per sales order, one line per rectangle,
 * and real tasks on real machines — not a report about cutting, the cutting.
 *
 * Until now nesting produced no work at all. Every row it wrote had a null flow
 * by design, and the plate was quietly consumed much later, when the first task
 * on some part started. Cutting had no duration, no machine, and no place on the
 * Plan Board, while being the first thing that happens to every part in the
 * building.
 *
 * ── WHY THE BLANKS LIVE ON THE CUTTING ORDER, NOT THE SALES ORDER ────────────
 *
 * This was the design decision worth getting right. A blank row put on the sales
 * order would be a top-level structure row that is not part of the structure —
 * it would show up in the editor as a sibling of the Span, it would be counted
 * as a made leaf by the very function that computes blanks, and every rebuild
 * would make blanks out of blanks.
 *
 * Giving the cutting order its own `order_id` solves all of that by construction
 * rather than by exception: the sales order's tree stays exactly what somebody
 * drew, and `materializeOrderTasks` builds the cutting tasks with no new code,
 * because a cutting order is an order with items and flows like any other.
 *
 * ── THE CHAIN AFTERWARDS ─────────────────────────────────────────────────────
 *
 *   PLATE  --(material row on the cutting order)-->  BLANK
 *   BLANK  --(material row on the sales order)---->  PART
 *
 * Each hop is a real transformation someone does. Before, there was one hop —
 * plate straight to part — which is why 960 identical stiffeners were 960
 * separate claims on steel.
 *
 * ── WHAT IS DELIBERATELY NOT DONE HERE ───────────────────────────────────────
 *
 * A part's first task is NOT yet made to wait on its blank's cutting task. That
 * is a cross-order edge in `fab_task_inputs`, and wiring it wrongly would either
 * deadlock the order or gate nothing at all. It is the next piece, on its own.
 */

import { pool } from '../../../db.js';
import { materialiseBlanks } from './blankService.js';
import { materializeOrderTasks } from './taskGatingService.js';
import { logger } from '../../../core/utils/logger.js';

/** The flow every nest gets unless somebody says otherwise. */
export const DEFAULT_CUTTING_FLOW_CODE = 'C0001';

async function nextOrderNumber(exec, companyId, prefix, ymd) {
  const [[row]] = await exec.query(
    `SELECT COUNT(*) AS n FROM fab_orders
      WHERE company_id = ? AND order_type = 'cutting'`,
    [companyId],
  );
  return `${prefix}-${ymd}-${String(Number(row.n) + 1).padStart(4, '0')}`;
}

/** The cutting order for a sales order, made if it is not there yet. */
export async function ensureCuttingOrder(companyId, salesOrderId, conn) {
  const [[sales]] = await conn.query(
    `SELECT id, order_number AS orderNumber, plant_id AS plantId, required_date AS requiredDate
       FROM fab_orders
      WHERE id = ? AND company_id = ? AND order_type = 'sales' AND deleted_at IS NULL LIMIT 1`,
    [salesOrderId, companyId],
  );
  if (!sales) { const e = new Error('That sales order does not exist.'); e.status = 404; throw e; }

  const [[found]] = await conn.query(
    `SELECT id, order_number AS orderNumber, status FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'cutting' AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [companyId, salesOrderId],
  );
  if (found) return { ...found, sales, created: false };

  const [[{ ymd }]] = await conn.query("SELECT DATE_FORMAT(UTC_DATE(), '%Y%m%d') AS ymd");
  const orderNumber = await nextOrderNumber(conn, companyId, 'CO', ymd);
  const [ins] = await conn.query(
    `INSERT INTO fab_orders
       (company_id, order_number, order_type, status, source_order_id, plant_id,
        required_date, notes, created_at)
     VALUES (?,?,'cutting','draft',?,?,?,?,NOW())`,
    [companyId, orderNumber, salesOrderId, sales.plantId ?? null, sales.requiredDate ?? null,
      `Plate to blanks for ${sales.orderNumber}`],
  );
  return { id: ins.insertId, orderNumber, status: 'draft', sales, created: true };
}

/**
 * Accept a nesting plan: make the blanks real, raise the cutting order, and
 * point every part at the blank it now comes from.
 *
 * @param {object} plan  { [blankKey]: { plateCatalogItemId, plates, perPlate, flowId } }
 *   Whatever the suggestor proposed or somebody built by hand. A blank missing
 *   from the plan still gets its row and its tasks — it just has no plate named
 *   yet, which reads honestly as "we have not decided where this comes from".
 */
export async function acceptPlan(companyId, salesOrderId, plan = {}, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();

    // 1 ── the blanks become catalogue items
    const mat = await materialiseBlanks(companyId, salesOrderId, conn);
    if (!mat.blanks.length) {
      const e = new Error('Nothing on this order can be nested yet — no part has a size on it.');
      e.status = 400; throw e;
    }

    // 2 ── the document
    const co = await ensureCuttingOrder(companyId, salesOrderId, conn);

    const [[flow]] = await conn.query(
      `SELECT id FROM fab_operation_flows
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, DEFAULT_CUTTING_FLOW_CODE],
    );
    if (!flow) {
      const e = new Error(`No cutting flow (${DEFAULT_CUTTING_FLOW_CODE}) to put this work on.`);
      e.status = 500; throw e;
    }

    // 3 ── one row per blank, on the cutting order
    const [existingRows] = await conn.query(
      `SELECT id, catalog_item_id AS catalogItemId, qty, flow_id AS flowId
         FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
          AND node_kind = 'structure'`,
      [companyId, co.id],
    );
    const rowByCatalog = new Map(existingRows.map((r) => [Number(r.catalogItemId), r]));

    let rowsCreated = 0;
    let rowsUpdated = 0;
    const blankRowId = new Map();     // blank key -> fab_items id on the cutting order

    for (const b of mat.blanks) {
      const chosen = plan[b.key] ?? {};
      const flowId = Number(chosen.flowId) || flow.id;
      const was = rowByCatalog.get(Number(b.catalogItemId));

      if (was) {
        if (Number(was.qty) !== b.qty || Number(was.flowId) !== flowId) {
          await conn.query(
            `UPDATE fab_items SET qty = ?, flow_id = ?, name = ? WHERE id = ? AND company_id = ?`,
            [b.qty, flowId, b.name, was.id, companyId],
          );
          rowsUpdated += 1;
        }
        blankRowId.set(b.key, Number(was.id));
      } else {
        const [r] = await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id)
           VALUES (?,?,NULL,NULL,?,?,'nos',?,?,'structure',0,1,'make',?)`,
          [companyId, co.id, b.catalogItemId, b.name, b.qty, b.code, flowId],
        );
        blankRowId.set(b.key, r.insertId);
        rowsCreated += 1;
      }
    }

    /*
     * A blank the order no longer needs takes its row with it. The structure
     * gets edited, rectangles change, and a cutting line for something nobody
     * is making would still be scheduled and still draw plate.
     */
    const liveCatalogIds = mat.blanks.map((b) => Number(b.catalogItemId));
    const [staleRows] = await conn.query(
      `SELECT id FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND node_kind = 'structure'
          ${liveCatalogIds.length ? 'AND catalog_item_id NOT IN (?)' : ''}`,
      liveCatalogIds.length ? [companyId, co.id, liveCatalogIds] : [companyId, co.id],
    );
    if (staleRows.length) {
      const ids = staleRows.map((r) => r.id);
      const [[worked]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_project_tasks
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL
            AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
        [companyId, ids],
      );
      if (worked.n > 0) {
        const e = new Error(
          `Refused: ${worked.n} cutting task(s) for blanks this order no longer needs have already `
          + 'been started. Re-nesting would throw that away.');
        e.status = 409; e.code = 'WORK_STARTED'; throw e;
      }
      await conn.query(
        `UPDATE fab_project_tasks SET deleted_at = NOW()
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`, [companyId, ids]);
      await conn.query(
        `UPDATE fab_items SET deleted_at = NOW()
          WHERE company_id = ? AND (id IN (?) OR parent_item_id IN (?)) AND deleted_at IS NULL`,
        [companyId, ids, ids]);
    }

    // 4 ── the plate under each blank: the RM -> blank mapping
    const rowIds = [...blankRowId.values()];
    if (rowIds.length) {
      await conn.query(
        `UPDATE fab_items SET deleted_at = NOW()
          WHERE company_id = ? AND parent_item_id IN (?) AND node_kind = 'material'
            AND deleted_at IS NULL`,
        [companyId, rowIds],
      );
    }
    let nestNo = 0;
    let platesLinked = 0;
    for (const b of mat.blanks) {
      const chosen = plan[b.key];
      if (!chosen?.plateCatalogItemId) continue;
      const parentId = blankRowId.get(b.key);
      const plates = Math.max(1, Number(chosen.plates) || 1);
      const [[pc]] = await conn.query(
        `SELECT id, code, name, thickness_mm AS thickness FROM fab_item_catalog
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [chosen.plateCatalogItemId, companyId],
      );
      if (!pc) continue;
      nestNo += 1;
      await conn.query(
        `INSERT INTO fab_items
           (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
            name, unit, qty, code, node_kind, depth, is_leaf, procurement_type,
            flow_id, nest_no, length, width, height)
         VALUES (?,?,NULL,?,?,?,'nos',?,?,'material',1,0,'buy',NULL,?,?,?,?)`,
        [companyId, co.id, parentId, pc.id, pc.name, plates,
          `${b.code}-${pc.code}`, `N-${String(nestNo).padStart(3, '0')}`,
          chosen.plateLength ?? null, chosen.plateWidth ?? null, pc.thickness ?? null],
      );
      platesLinked += 1;
    }

    // 5 ── every part now comes off its blank, not off plate
    let partsRepointed = 0;
    for (const b of mat.blanks) {
      for (const part of b.parts) {
        await conn.query(
          `UPDATE fab_items SET deleted_at = NOW()
            WHERE company_id = ? AND parent_item_id = ? AND node_kind = 'material'
              AND deleted_at IS NULL`,
          [companyId, part.itemId],
        );
        await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type,
              flow_id, length, width, height)
           SELECT ?, order_id, order_line_id, ?, ?, ?, 'nos', ?, ?, 'material', depth + 1, 0,
                  'make', NULL, ?, ?, ?
             FROM fab_items WHERE id = ? AND company_id = ?`,
          [companyId, part.itemId, b.catalogItemId, b.name, part.qty,
            `${b.code}-${part.itemId}`, b.length, b.width, b.thickness,
            part.itemId, companyId],
        );
        partsRepointed += 1;
      }
    }

    // 6 ── the work itself
    const materialized = await materializeOrderTasks(conn, companyId, co.id);

    if (owned) await conn.commit();
    const out = {
      cuttingOrderId: co.id,
      cuttingOrderNumber: co.orderNumber,
      created: co.created,
      blanks: mat.blanks.length,
      blanksCreated: mat.created,
      blanksRetired: mat.retired ?? 0,
      rowsCreated,
      rowsUpdated,
      rowsRetired: staleRows.length,
      platesLinked,
      partsRepointed,
      tasks: materialized?.tasksInserted ?? 0,
      skipped: mat.skipped,
    };
    logger.info({ companyId, salesOrderId, ...out }, 'fab_erp: nesting plan accepted, cutting order raised');
    return out;
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
