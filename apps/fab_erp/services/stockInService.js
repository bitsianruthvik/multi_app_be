/**
 * stockInService.js — add raw material straight into a stock area.
 *
 * Replaces the goods-receipt flow. There is no purchase order, no supplier and
 * no delivery document: material arrives, someone records what and where, and
 * the tasks waiting on it become eligible.
 *
 * WHY THIS IS A DEDICATED ROUTE AND NOT /mutate
 * ---------------------------------------------
 * `fabErpStockPiece` is already writable through the generic query API, so a
 * piece *can* be inserted that way. It must not be. Two things happen here that
 * /mutate has no hook for:
 *
 *   1. the ledger row, which is the only history Stock has to show, and
 *   2. reevaluateStockGatedTasks() — the ONLY thing in the codebase that
 *      re-checks tasks blocked waiting for material.
 *
 * That second one is the whole point. Gating never reads a supplier or receipt
 * table — availableQty() sums fab_stock_pieces and nothing else — so nothing
 * *looks* coupled. But a task materialized as `blocked` on a raw-material input
 * only re-checks when something calls that function. Insert a piece without it
 * and the stock is visibly on hand while the task waits forever, with no error
 * anywhere. postGrn() was its only caller; this is now its only caller.
 *
 * MULTI-PIECE ENTRY
 * -----------------
 * Kept, though a single quantity would have been simpler. consumeStock deducts
 * piece by piece and stamps each ledger row with that piece's batch, and the
 * Stock screen segments by piece — so plate arriving as six plates with six
 * heat numbers has to be six rows, or heat traceability is lost the moment the
 * first one is cut.
 */

import { pool } from '../../../db.js';
import { reevaluateStockGatedTasks } from './taskGatingService.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * The ledger's batch_code is a display string, not a key. Fall back through the
 * traceability fields so a row always says something useful about which physical
 * piece it was; 'N/A' only when the piece carries no identity at all.
 */
function displayBatchCode(piece) {
  return piece.batch_no || piece.serial_no || piece.heat_no || piece.mark_no || 'N/A';
}

/**
 * Receive raw material into stock.
 *
 * @param {number} companyId
 * @param {object} input
 * @param {number} input.catalog_item_id
 * @param {number} input.plant_id
 * @param {number} input.stock_location_id
 * @param {string} input.received_date        YYYY-MM-DD — never null, see below
 * @param {string|null} [input.uom]
 * @param {number|null} [input.unit_cost]
 * @param {string|null} [input.notes]
 * @param {Array<{qty:number, batch_no?, heat_no?, serial_no?, mark_no?}>} input.pieces
 * @returns {Promise<{ok:true, pieceIds:number[], qtyTotal:number, tasksCleared:number[]}>}
 */
export async function receiveStock(companyId, input) {
  const {
    catalog_item_id: catalogItemId,
    plant_id: plantId,
    stock_location_id: stockLocationId,
    received_date: receivedDate,
    uom = null,
    unit_cost: unitCost = null,
    notes = null,
    pieces = [],
  } = input ?? {};

  const conn = await pool.getConnection();
  const pieceIds = [];
  let qtyTotal = 0;

  try {
    await conn.beginTransaction();

    // uom is copied from the catalog item when the caller didn't supply one.
    // postGrn never set it, so every piece in the system has a NULL unit —
    // harmless until something tries to add kg to pieces.
    let resolvedUom = uom;
    if (!resolvedUom) {
      const [[cat]] = await conn.query(
        `SELECT unit FROM fab_item_catalog
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [catalogItemId, companyId],
      );
      resolvedUom = cat?.unit ?? null;
    }

    for (const piece of pieces) {
      const qty = Number(piece.qty);
      const batchNo = piece.batch_no ?? null;
      const heatNo = piece.heat_no ?? null;
      const serialNo = piece.serial_no ?? null;
      const markNo = piece.mark_no ?? null;

      const [pieceResult] = await conn.query(
        `INSERT INTO fab_stock_pieces
           (company_id, catalog_item_id, plant_id, stock_location_id,
            batch_no, heat_no, serial_no, mark_no, qty, uom, unit_cost,
            status, received_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?)`,
        [
          companyId, catalogItemId, plantId, stockLocationId,
          batchNo, heatNo, serialNo, markNo, qty, resolvedUom, unitCost,
          // received_date drives FIFO in wipInventoryService.consumeStock, where
          // NULL sorts last — a piece received with no date would be consumed
          // after everything else regardless of when it actually arrived.
          receivedDate, notes,
        ],
      );

      const pieceId = pieceResult.insertId;
      pieceIds.push(pieceId);
      qtyTotal += qty;

      await conn.query(
        `INSERT INTO fab_stock_ledger
           (company_id, catalog_item_id, plant_id, stock_location_id, batch_id,
            batch_code, piece_id, batch_no, serial_no, heat_no, mark_no,
            txn_type, qty, unit_cost, txn_date)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'stock_in', ?, ?, ?)`,
        [
          companyId, catalogItemId, plantId, stockLocationId,
          displayBatchCode(piece), pieceId,
          batchNo, serialNo, heatNo, markNo,
          qty, unitCost, receivedDate,
        ],
      );
    }

    await conn.commit();

    // Post-commit, best-effort. A hook failure must not fail stock that is
    // already recorded — but without this call the material is on hand and every
    // task gated on it stays blocked, silently and indefinitely.
    let tasksCleared = [];
    try {
      tasksCleared = await reevaluateStockGatedTasks(conn, companyId, [Number(catalogItemId)]);
    } catch (hookErr) {
      logger.error(
        { err: hookErr, companyId, catalogItemId },
        '[stock-in] gate re-evaluation failed; stock is committed but blocked tasks were not re-checked',
      );
    }

    return { ok: true, pieceIds, qtyTotal, tasksCleared };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
