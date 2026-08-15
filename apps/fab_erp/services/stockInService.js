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
import { rollUpOrderStatus } from './taskEngineService.js';
import { generateCode } from './codegenService.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * The ledger's batch_code is a display string, not a key. Fall back through the
 * traceability fields so a row always says something useful about which physical
 * piece it was; 'N/A' only when the piece carries no identity at all.
 */
function displayBatchCode(piece) {
  // The piece's own code leads now that every piece gets one: it names exactly
  // this piece, where a batch or heat number names the lot it came from. The
  // supplier-supplied fields stay ahead of nothing and behind the code, and
  // 'N/A' survives only for rows written before codes existed.
  return piece.code || piece.batch_no || piece.serial_no || piece.heat_no || piece.mark_no || 'N/A';
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
export async function receiveStock(companyId, input, outerConn = null) {
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

  /**
   * A caller may hand in its own transaction.
   *
   * Receiving against a purchase-order line has to book the stock AND close the
   * line in one go: stock that arrived without its line being updated leaves
   * the outstanding quantity permanently wrong, and nothing would ever notice.
   * When `outerConn` is supplied this function joins that transaction and
   * leaves begin/commit/rollback to whoever owns it. Called the old way it
   * still owns its own, so every existing caller is unaffected.
   */
  const joined = !!outerConn;
  const conn = outerConn ?? await pool.getConnection();
  const pieceIds = [];
  let qtyTotal = 0;

  try {
    if (!joined) await conn.beginTransaction();

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
      // Accepts either casing: the GRN dialog posts camelCase, the bulk
      // stock-in sheet snake_case, and a size silently dropped because of the
      // wrong key would be indistinguishable from one nobody entered.
      const numOrNull = (v) => {
        if (v === '' || v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const lengthMm = numOrNull(piece.length_mm ?? piece.lengthMm);
      const widthMm = numOrNull(piece.width_mm ?? piece.widthMm);

      // Issued on THIS connection so the number and the row it names are one
      // atomic act: a rolled-back receipt must not leave a hole in the
      // sequence, and the piece must never exist uncoded.
      const code = await generateCode(companyId, 'stock_piece', {}, conn);

      const [pieceResult] = await conn.query(
        `INSERT INTO fab_stock_pieces
           (company_id, code, catalog_item_id, plant_id, stock_location_id,
            batch_no, heat_no, serial_no, mark_no, qty, uom, unit_cost,
            length_mm, width_mm,
            status, received_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?)`,
        [
          companyId, code,
          catalogItemId, plantId, stockLocationId,
          batchNo, heatNo, serialNo, markNo, qty, resolvedUom, unitCost,
          // The PIECE's size. These columns have existed since the stock-piece
          // redesign and nothing ever wrote them, so every row was NULL — which
          // is why procurement could only ever match on catalog item and a
          // 2000x1000 offcut "covered" a 12000x2500 nest. Thickness is not here
          // on purpose: a "20mm plate" catalog item IS its thickness, so the
          // catalog link already carries it.
          lengthMm, widthMm,
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
          displayBatchCode({ ...piece, code }), pieceId,
          batchNo, serialNo, heatNo, markNo,
          qty, unitCost, receivedDate,
        ],
      );
    }

    if (!joined) await conn.commit();

    // Post-commit, best-effort, but retried — because this call is the ONLY
    // thing in the system that moves a task off 'blocked' for material. There is
    // no sweeper and no queue behind it: if it fails silently the stock is on
    // hand, the work stays blocked, and nobody finds out until someone asks why
    // a machine is idle. A transient deadlock or timeout is exactly the failure
    // mode worth retrying, so it gets three quick attempts before we give up.
    let tasksCleared = [];
    let gateError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        tasksCleared = await reevaluateStockGatedTasks(conn, companyId, [Number(catalogItemId)]);
        gateError = null;
        break;
      } catch (hookErr) {
        gateError = hookErr;
        logger.warn(
          { err: hookErr, companyId, catalogItemId, attempt },
          '[stock-in] gate re-evaluation attempt failed',
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }

    if (gateError) {
      logger.error(
        { err: gateError, companyId, catalogItemId },
        '[stock-in] gate re-evaluation failed after 3 attempts; stock is committed but blocked tasks were not re-checked',
      );
    }

    /**
     * A task clearing its material gate is exactly the moment a production
     * order stops waiting and starts producing — "the first raw material it
     * needs turns up". Nothing else observes it, so it is observed here.
     *
     * Best-effort like the gate check above: the stock is real and committed,
     * and a status that lags is a smaller problem than a receipt that fails.
     */
    if (tasksCleared.length) {
      try {
        // A task carries its SALES order id, and rollUpOrderStatus refreshes the
        // production order before mirroring it — so one call per affected order
        // moves both documents. Going via the production order directly would
        // leave the sales order reading a value nobody had recomputed.
        const [orders] = await conn.query(
          `SELECT DISTINCT order_id FROM fab_project_tasks
            WHERE company_id = ? AND id IN (?) AND order_id IS NOT NULL`,
          [companyId, tasksCleared],
        );
        for (const o of orders) {
          await rollUpOrderStatus(conn, companyId, o.order_id);
        }
      } catch (moErr) {
        logger.warn(
          { err: moErr, companyId, cleared: tasksCleared.length },
          '[stock-in] order statuses not re-checked after gate clear',
        );
      }
    }

    // Reported, not swallowed. The receipt succeeded and must not be undone, but
    // the caller needs to know the second half did not happen — otherwise the
    // screen says "stock added, 4 tasks unblocked" when nothing was unblocked.
    return {
      ok: true,
      pieceIds,
      qtyTotal,
      tasksCleared,
      gateCheckFailed: !!gateError,
    };
  } catch (err) {
    if (!joined) await conn.rollback();
    throw err;
  } finally {
    if (!joined) conn.release();
  }
}
