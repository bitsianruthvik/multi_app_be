/**
 * orderLineQty.js — the one place line quantity turns into a multiplier.
 *
 * THE RULE, WRITTEN ONCE: the root `fab_items` row stays qty 1. Every roll-up
 * that counts pieces per order multiplies by the qty of the line the row hangs
 * under, exactly once, at the outermost sum. Nothing writes `fab_order_lines.qty`
 * onto `fab_items` — a row is a design, and the line says how many times the
 * order needs it (User Clarifications 3).
 *
 * Every caller below joins through `fab_items.order_line_id`. A row with no
 * line (NULL) multiplies by 1 — it does not vanish from a total.
 */

import { pool } from '../../../db.js';

/**
 * `Map<orderLineId, qty>` for one order, DECIMAL coerced to a number (§13
 * "MySQL returns DECIMAL as a string").
 *
 * @param {object} conn - the caller's connection/pool
 * @param {number} companyId
 * @param {number} orderId
 * @returns {Promise<Map<number, number>>}
 */
export async function lineQtyMap(conn, companyId, orderId) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT id, qty FROM fab_order_lines
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  const map = new Map();
  for (const r of rows) {
    // Mirrors LINE_QTY_SQL's own COALESCE(fol.qty, 1): only a NULL substitutes
    // 1, so a genuinely stored 0 (the column's own default before anyone fills
    // it in) reads as 0 in JS exactly as it would in SQL — two definitions
    // that disagreed on this edge would be worse than either being wrong alone.
    const q = r.qty == null ? 1 : Number(r.qty);
    map.set(Number(r.id), Number.isFinite(q) ? q : 1);
  }
  return map;
}

/**
 * SQL fragment for a query already aliasing `fab_items` as `itemAlias` and
 * joined to `fab_order_lines fol` (see below). A row with no line, or a line
 * whose qty is NULL, multiplies by 1.
 *
 * Pair with:
 *   LEFT JOIN fab_order_lines fol
 *     ON fol.id = <itemAlias>.order_line_id AND fol.deleted_at IS NULL
 */
export const LINE_QTY_SQL = 'COALESCE(fol.qty, 1)';
