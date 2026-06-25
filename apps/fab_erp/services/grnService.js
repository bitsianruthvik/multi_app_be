/**
 * grnService.js
 * -------------
 * EU-5: Goods Receipt Note (GRN) posting service for fab_erp.
 *
 * Exported function:
 *   postGrn(companyId, { header, lines })
 *
 * Posting flow (single transaction):
 *   1. Insert the GRN header into fab_grns (status = 'posted').
 *   2. For each line, in order:
 *        a. Upsert fab_item_batches: increment qty_on_hand if a matching
 *           batch (company/item/plant/location/batch_code) exists, otherwise
 *           insert a new batch row with qty_on_hand = line.qty.
 *        b. Insert the GRN line into fab_grn_lines, linked to the batch.
 *        c. Append a 'grn_receipt' entry to fab_stock_ledger.
 *        d. If a fab_stock_balances row exists for this item/plant/location,
 *           reduce qty_ordered by line.qty (floored at 0). If no balance row
 *           exists, skip — this is a receipt-only scenario and no new
 *           balance row is created here.
 *   3. Commit the transaction and return { ok, grnId, lineCount }.
 *
 * On any error the transaction is rolled back and the error is rethrown for
 * the route handler to translate into an HTTP response (e.g. ER_DUP_ENTRY
 * on fab_grns.uq_fab_grns_number -> 409).
 */

import { pool } from '../../../db.js';

// ---------------------------------------------------------------------------
// postGrn
// ---------------------------------------------------------------------------

/**
 * @param {number} companyId
 * @param {{ header: object, lines: object[] }} params
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
      // a. Batch upsert
      const [batchRows] = await conn.query(
        `SELECT id, qty_on_hand
           FROM fab_item_batches
          WHERE company_id = ?
            AND catalog_item_id = ?
            AND plant_id = ?
            AND stock_location_id = ?
            AND batch_code = ?
            AND deleted_at IS NULL
          FOR UPDATE`,
        [
          companyId,
          line.catalog_item_id,
          header.plant_id,
          header.stock_location_id,
          line.batch_code,
        ],
      );

      let batchId;

      if (batchRows.length) {
        batchId = batchRows[0].id;
        await conn.query(
          `UPDATE fab_item_batches
              SET qty_on_hand = qty_on_hand + ?
            WHERE id = ?`,
          [line.qty, batchId],
        );
      } else {
        const [batchInsertResult] = await conn.query(
          `INSERT INTO fab_item_batches
             (company_id, catalog_item_id, plant_id, stock_location_id,
              batch_code, qty_on_hand, received_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            companyId,
            line.catalog_item_id,
            header.plant_id,
            header.stock_location_id,
            line.batch_code,
            line.qty,
            header.grn_date,
          ],
        );
        batchId = batchInsertResult.insertId;
      }

      // b. Insert GRN line
      const [grnLineResult] = await conn.query(
        `INSERT INTO fab_grn_lines
           (company_id, grn_id, catalog_item_id, batch_id, batch_code, qty, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          grnId,
          line.catalog_item_id,
          batchId,
          line.batch_code,
          line.qty,
          line.unit_cost ?? null,
        ],
      );

      const grnLineId = grnLineResult.insertId;

      // c. Insert ledger entry
      await conn.query(
        `INSERT INTO fab_stock_ledger
           (company_id, catalog_item_id, plant_id, stock_location_id, batch_id,
            batch_code, txn_type, qty, unit_cost, supplier_id, grn_id, grn_line_id, txn_date)
         VALUES (?, ?, ?, ?, ?, ?, 'grn_receipt', ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          line.catalog_item_id,
          header.plant_id,
          header.stock_location_id,
          batchId,
          line.batch_code,
          line.qty,
          line.unit_cost ?? null,
          header.supplier_id ?? null,
          grnId,
          grnLineId,
          header.grn_date,
        ],
      );

      // d. Balance row: reduce qty_ordered and increment qty_on_hand
      await conn.query(
        `INSERT INTO fab_stock_balances
           (company_id, catalog_item_id, plant_id, stock_location_id, qty_on_hand, qty_ordered, qty_earmarked)
         VALUES (?, ?, ?, ?, ?, 0, 0)
         ON DUPLICATE KEY UPDATE
           qty_on_hand  = qty_on_hand + VALUES(qty_on_hand),
           qty_ordered  = GREATEST(0, qty_ordered - VALUES(qty_on_hand))`,
        [companyId, line.catalog_item_id, header.plant_id, header.stock_location_id, line.qty],
      );
    }

    await conn.commit();

    return { ok: true, grnId, lineCount: lines.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
