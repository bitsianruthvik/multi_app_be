/**
 * grnService.js
 * -------------
 * EU-3: Goods Receipt Note (GRN) posting service for fab_erp.
 *
 * Exported function:
 *   postGrn(companyId, { header, lines })
 *
 * Posting flow (single transaction) — piece-level model (post stock-piece
 * redesign, see PLAN.md EU-1/EU-3):
 *   1. Insert the GRN header into fab_grns (status = 'posted').
 *   2. For each line, in order:
 *        a. Insert the GRN line into fab_grn_lines. Its qty is the SUM of
 *           that line's pieces' qty (fab_grn_lines has no piece breakdown
 *           of its own — it's the ordered-quantity summary row).
 *        b. For each piece object on the line, insert one fab_stock_pieces
 *           row (the piece IS the physical stock record now — there is no
 *           separate batch-aggregate or balance table to keep in sync).
 *        c. For each piece just inserted, append one 'grn_receipt' entry to
 *           fab_stock_ledger with piece_id pointing at the new piece, in the
 *           SAME transaction (ledger writes must never be split from the
 *           piece write they describe).
 *   3. Commit the transaction and return { ok, grnId, lineCount }.
 *
 * Traceability: batch_no / heat_no / serial_no / mark_no are free-text
 * per-piece attributes now — there is no more category/item "required"
 * flag (fab_item_categories.*_required and fab_item_catalog.*_required_override
 * were dropped in EU-1). Every item is processed uniformly; routes/grn.js no
 * longer does pre-post traceability validation.
 *
 * Schema note: fab_grn_lines.batch_code, fab_stock_ledger.batch_id, and
 * fab_stock_ledger.batch_code are now NULLable (see init.sql's "Relax
 * remaining legacy NOT NULL columns" block, appended after the stock-piece
 * redesign block). batch_id is written as NULL — fab_item_batches (the table
 * it used to reference) was dropped in EU-1, and 0 was a misleading fake FK
 * value. batch_code is still populated with a human-readable summary string
 * derived from the piece's identifiers (falling back to 'N/A') rather than
 * NULL — unlike batch_id it never was a foreign key, and a denormalized
 * display string is still useful on the line/ledger rows without a piece
 * join. piece_id is the authoritative new pointer on the ledger.
 *
 * Custom fields: each piece may optionally carry a `custom_fields` array of
 * { field_key, field_type?, field_value? } entries. These are written to
 * fab_custom_fields with level='stock_piece' and level_id = the new piece's
 * id, in the same transaction as the piece/ledger rows (see EU-6/PLAN.md).
 *
 * On any error the transaction is rolled back and the error is rethrown for
 * the route handler to translate into an HTTP response (e.g. ER_DUP_ENTRY
 * on fab_grns.uq_fab_grns_number -> 409).
 */

import { pool } from '../../../db.js';
import { reevaluateStockGatedTasks } from './taskGatingService.js';

// Human-readable display string for fab_grn_lines.batch_code /
// fab_stock_ledger.batch_code — denormalized, non-FK, still useful even
// though batch_id itself is written as NULL. Mirrors the pre-redesign
// display logic.
function displayBatchCode(piece) {
  return piece?.batch_no ?? piece?.serial_no ?? piece?.heat_no ?? piece?.mark_no ?? 'N/A';
}

// ---------------------------------------------------------------------------
// postGrn
// ---------------------------------------------------------------------------

/**
 * @param {number} companyId
 * @param {{ header: object, lines: object[] }} params
 *   header: { grn_number, grn_date, plant_id, stock_location_id,
 *              supplier_id?, supplier_ref?, notes? }
 *   lines:  [{ catalog_item_id, unit_cost?,
 *               pieces: [{ qty, batch_no?, heat_no?, serial_no?, mark_no?,
 *                          custom_fields?: [{ field_key, field_type?, field_value? }, ...] }, ...] }, ...]
 * @returns {Promise<{ ok: boolean, grnId: number, lineCount: number }>}
 */
export async function postGrn(companyId, { header, lines }) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // ── 1. Insert GRN header ─────────────────────────────────────────────────
    const [grnResult] = await conn.query(
      `INSERT INTO fab_grns
         (company_id, grn_number, grn_date, plant_id, stock_location_id,
          supplier_id, supplier_ref, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted')`,
      [
        companyId,
        header.grn_number,
        header.grn_date,
        header.plant_id,
        header.stock_location_id,
        header.supplier_id ?? null,
        header.supplier_ref ?? null,
        header.notes ?? null,
      ],
    );

    const grnId = grnResult.insertId;

    // ── 2. Process each line ─────────────────────────────────────────────────
    for (const line of lines) {
      const pieces = Array.isArray(line.pieces) ? line.pieces : [];
      const lineQty = pieces.reduce((sum, p) => sum + Number(p.qty), 0);
      const lineBatchCode = displayBatchCode(pieces[0]);

      // a. Insert GRN line (aggregate qty across this line's pieces)
      const [grnLineResult] = await conn.query(
        `INSERT INTO fab_grn_lines
           (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
        [
          companyId,
          grnId,
          line.catalog_item_id,
          lineBatchCode,
          lineQty,
          line.unit_cost ?? null,
        ],
      );

      const grnLineId = grnLineResult.insertId;

      // b/c. One fab_stock_pieces row + one fab_stock_ledger row per piece
      for (const piece of pieces) {
        const batchNo  = piece.batch_no ?? null;
        const heatNo   = piece.heat_no ?? null;
        const serialNo = piece.serial_no ?? null;
        const markNo   = piece.mark_no ?? null;
        const pieceQty = piece.qty;

        const [pieceResult] = await conn.query(
          `INSERT INTO fab_stock_pieces
             (company_id, catalog_item_id, plant_id, stock_location_id,
              batch_no, heat_no, serial_no, mark_no, qty, unit_cost, status,
              grn_id, grn_line_id, received_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?)`,
          [
            companyId,
            line.catalog_item_id,
            header.plant_id,
            header.stock_location_id,
            batchNo, heatNo, serialNo, markNo,
            pieceQty,
            line.unit_cost ?? null,
            grnId,
            grnLineId,
            header.grn_date,
          ],
        );

        const pieceId = pieceResult.insertId;
        const pieceBatchCode = displayBatchCode(piece);

        await conn.query(
          `INSERT INTO fab_stock_ledger
             (company_id, catalog_item_id, plant_id, stock_location_id, batch_id,
              batch_code, piece_id, batch_no, serial_no, heat_no, mark_no,
              txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'grn_receipt', ?, ?, ?, ?, ?, ?)`,
          [
            companyId,
            line.catalog_item_id,
            header.plant_id,
            header.stock_location_id,
            pieceBatchCode,
            pieceId,
            batchNo, serialNo, heatNo, markNo,
            pieceQty,
            line.unit_cost ?? null,
            header.supplier_id ?? null,
            grnId,
            grnLineId,
            header.grn_date,
          ],
        );

        // d. Piece-level custom field values (fab_custom_fields, level='stock_piece')
        const customFields = Array.isArray(piece.custom_fields) ? piece.custom_fields : [];

        for (let k = 0; k < customFields.length; k++) {
          const cf = customFields[k];

          await conn.query(
            `INSERT INTO fab_custom_fields
               (company_id, level, level_id, field_key, field_type, field_value, sort_order)
             VALUES (?, 'stock_piece', ?, ?, ?, ?, ?)`,
            [
              companyId,
              pieceId,
              cf.field_key,
              cf.field_type ?? 'text',
              cf.field_value ?? null,
              Number.isInteger(cf.sort_order) ? cf.sort_order : k,
            ],
          );
        }
      }
    }

    await conn.commit();

    // Post-commit: unblock any tasks that were waiting on this stock to arrive.
    // Best-effort — a hook failure must never fail an already-committed GRN.
    let tasksCleared = [];
    try {
      const catalogItemIds = lines.map((l) => Number(l.catalog_item_id)).filter(Boolean);
      tasksCleared = await reevaluateStockGatedTasks(conn, companyId, catalogItemIds);
    } catch (hookErr) {
      // swallow — GRN is committed; gating will still re-check on next event
    }

    return { ok: true, grnId, lineCount: lines.length, tasksCleared };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
