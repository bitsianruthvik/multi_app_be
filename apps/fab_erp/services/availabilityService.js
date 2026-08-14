/**
 * availabilityService.js — what stock is actually free to promise.
 *
 * Three different numbers get called "stock" and only one of them answers
 * "should I buy this":
 *
 *   ON HAND    every piece physically in a stock area (status 'in_stock').
 *              WIP and consumed pieces are not stock — one is part-built into
 *              something, the other is gone.
 *   RESERVED   on-hand quantity already earmarked, by an order at its
 *              procurement step or by a task at its material gate.
 *   AVAILABLE  on hand minus reserved, floored at zero.
 *
 * Shortfall computed against ON HAND is the bug that reservations exist to
 * prevent: two orders ask at the same time, both are told the same plate is
 * free, both are told to buy nothing, and one of them finds out on the shop
 * floor. Reservations were removed on 2026-08-05 and are back for this reason.
 *
 * An order NEVER counts its own reservations against itself — it already holds
 * that stock, so subtracting it would send it out to buy what it has.
 */

import { pool } from '../../../db.js';

/**
 * On hand / reserved / available for a set of catalog items.
 *
 * @param {number} companyId
 * @param {number[]} catalogItemIds
 * @param {object} [opts]
 * @param {number} [opts.forOrderId] exclude this order's own reservations
 * @param {object} [opts.conn] run inside a caller's transaction
 * @returns {Promise<Map<number, {onHand:number, reserved:number, available:number}>>}
 */
export async function availabilityFor(companyId, catalogItemIds, opts = {}) {
  const { forOrderId = null, conn = null } = opts;
  const exec = conn ?? pool;
  const ids = [...new Set((catalogItemIds || []).filter((n) => Number.isFinite(Number(n))))];
  const out = new Map();
  if (!ids.length) return out;

  const placeholders = ids.map(() => '?').join(',');

  const [stock] = await exec.query(
    `SELECT catalog_item_id, COALESCE(SUM(qty), 0) AS on_hand
       FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'in_stock'
        AND catalog_item_id IN (${placeholders})
      GROUP BY catalog_item_id`,
    [companyId, ...ids],
  );

  // `order_id <=> ?` rather than `<> ?`: a NULL order_id must still be counted
  // when excluding an order, and NULL <> 5 is NULL, which silently drops rows.
  const [res] = await exec.query(
    `SELECT catalog_item_id, COALESCE(SUM(qty), 0) AS reserved
       FROM fab_stock_reservations
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'
        AND catalog_item_id IN (${placeholders})
        AND NOT (? IS NOT NULL AND order_id <=> ?)
      GROUP BY catalog_item_id`,
    [companyId, ...ids, forOrderId, forOrderId],
  );

  const onHandBy = new Map(stock.map((r) => [Number(r.catalog_item_id), Number(r.on_hand)]));
  const resBy = new Map(res.map((r) => [Number(r.catalog_item_id), Number(r.reserved)]));

  for (const id of ids) {
    const onHand = onHandBy.get(Number(id)) || 0;
    const reserved = resBy.get(Number(id)) || 0;
    out.set(Number(id), {
      onHand,
      reserved,
      available: Math.max(0, onHand - reserved),
    });
  }
  return out;
}

/**
 * Earmark stock for an order, up to what it needs and no further.
 *
 * Reserving MORE than is available would be a promise the shelf cannot keep, so
 * each line reserves min(needed, available). Whatever is left over is the
 * shortfall, and the shortfall is what gets purchased.
 *
 * Idempotent per (order, catalog item): re-running replaces that pair's active
 * reservation rather than stacking a second one on top. Pressing the button
 * twice is not a reason to hold twice the steel.
 *
 * @returns {Promise<Array<{catalogItemId:number, reserved:number}>>}
 */
export async function reserveForOrder(conn, companyId, orderId, needs) {
  const exec = conn ?? pool;
  const rows = [];

  for (const { catalogItemId, qty } of needs) {
    const id = Number(catalogItemId);
    if (!Number.isFinite(id) || !(Number(qty) > 0)) continue;

    // Availability is read WITHOUT this order's own holding, then its holding is
    // rewritten — otherwise a re-run would see its own reservation as somebody
    // else's and reserve nothing.
    const avail = await availabilityFor(companyId, [id], { forOrderId: orderId, conn: exec });
    const free = avail.get(id)?.available ?? 0;
    const take = Math.min(Number(qty), free);

    await exec.query(
      `UPDATE fab_stock_reservations
          SET status = 'released', released_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND catalog_item_id = ?
          AND kind = 'order' AND status = 'active' AND deleted_at IS NULL`,
      [companyId, orderId, id],
    );

    if (take > 0) {
      await exec.query(
        `INSERT INTO fab_stock_reservations
           (company_id, catalog_item_id, kind, order_id, qty, status)
         VALUES (?, ?, 'order', ?, ?, 'active')`,
        [companyId, id, orderId, take],
      );
    }
    rows.push({ catalogItemId: id, reserved: take });
  }
  return rows;
}

/** Give back everything an order is holding — cancelling it, or starting over. */
export async function releaseOrderReservations(conn, companyId, orderId) {
  const exec = conn ?? pool;
  const [r] = await exec.query(
    `UPDATE fab_stock_reservations
        SET status = 'released', released_at = UTC_TIMESTAMP()
      WHERE company_id = ? AND order_id = ? AND kind = 'order'
        AND status = 'active' AND deleted_at IS NULL`,
    [companyId, orderId],
  );
  return r?.affectedRows ?? 0;
}
