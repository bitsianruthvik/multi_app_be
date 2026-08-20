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
import { fieldMatchSql } from './fieldService.js';

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
    /**
     * OFFCUTS ARE NOT PLATES, so they do not count here.
     *
     * A drop carries the same catalog_item_id as the plate it came off — that
     * is what makes it findable as the same material — but it is a 0.8 m²
     * remnant, not a 24 m² sheet. Counting it as one unit of the item would
     * tell procurement the shelf holds a plate it does not hold, and the order
     * would be one plate short at the torch.
     *
     * The size-aware count (`availabilityBySize`) is already safe: a drop's odd
     * dimensions match no full-plate requirement. This catalog-level count is
     * the one that had no way to tell them apart, and it is the fallback used
     * whenever a line has no declared size — which is exactly the case where
     * getting it wrong is invisible.
     *
     * Drops are still real stock and still consumable; they are simply counted
     * by the code that knows what size they are.
     */
    `SELECT catalog_item_id, COALESCE(SUM(qty), 0) AS on_hand
       FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'in_stock'
        AND origin_piece_id IS NULL
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

/**
 * The same question, asked about a SPECIFIC PLATE SIZE.
 *
 * `availabilityFor` matches on catalog item alone, which is the bug this exists
 * to fix: a 2000x1000 offcut of 20mm plate fully "covered" a nest that needs a
 * 12000x2500 sheet of 20mm plate, because both are catalog item #N and `qty`
 * counts pieces. The order then went into production against material that
 * cannot produce it.
 *
 * Thickness is not compared here because it is not a property of the piece —
 * a "MS Plate 20mm" catalog row IS 20mm, so matching the catalog item has
 * already matched the thickness. Length and width are per piece, and those are
 * what `fab_stock_pieces.length_mm` / `width_mm` hold.
 *
 * UNSIZED STOCK IS COUNTED SEPARATELY, NEVER AS A MATCH. Those columns have
 * existed for a while and nothing ever populated them, so most pieces have NULL
 * on both. A NULL is not evidence that the plate is the right size, so it
 * cannot be allowed to satisfy a sized requirement — but silently ignoring it
 * would tell somebody to buy plate that may well be sitting in the yard. It is
 * returned as `unsized` so the screen can say exactly that.
 *
 * @param {{catalogItemId:number, length:number|null, width:number|null}[]} specs
 * @returns {Promise<Map<string, {onHand:number, unsized:number}>>} keyed by sizeKey()
 */
export const sizeKey = (catalogItemId, length, width) =>
  `${Number(catalogItemId)}|${length == null ? '' : Number(length)}|${width == null ? '' : Number(width)}`;

export async function availabilityBySize(companyId, specs, opts = {}) {
  const { conn = null } = opts;
  const exec = conn ?? pool;
  const out = new Map();
  const list = (specs || []).filter((s) => Number.isFinite(Number(s?.catalogItemId)));
  if (!list.length) return out;

  const ids = [...new Set(list.map((s) => Number(s.catalogItemId)))];
  const placeholders = ids.map(() => '?').join(',');

  // Every in-stock piece of these items, with whatever size it carries.
  const [pieces] = await exec.query(
    `SELECT catalog_item_id, length_mm, width_mm, COALESCE(SUM(qty), 0) AS on_hand
       FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL AND status = 'in_stock'
        AND catalog_item_id IN (${placeholders})
      GROUP BY catalog_item_id, length_mm, width_mm`,
    [companyId, ...ids],
  );

  const exactBy = new Map();     // sizeKey -> qty
  const unsizedBy = new Map();   // catalogItemId -> qty of pieces with no size recorded
  for (const p of pieces) {
    const id = Number(p.catalog_item_id);
    const qty = Number(p.on_hand) || 0;
    if (p.length_mm == null && p.width_mm == null) {
      unsizedBy.set(id, (unsizedBy.get(id) || 0) + qty);
      continue;
    }
    const k = sizeKey(id, p.length_mm, p.width_mm);
    exactBy.set(k, (exactBy.get(k) || 0) + qty);
  }

  for (const s of list) {
    const id = Number(s.catalogItemId);
    const k = sizeKey(id, s.length, s.width);
    out.set(k, {
      onHand: exactBy.get(k) || 0,
      unsized: unsizedBy.get(id) || 0,
    });
  }
  return out;
}

/**
 * Pieces of an item that are spoken for by SOMEBODY ELSE.
 *
 * A piece-level reservation names a plate. Once one exists, that plate is not
 * available to any other order, however much the catalog-level arithmetic says
 * is on hand — "3 of MS Plate 20mm" is not an answer when only one of them is
 * the 3000x1500 the nest needs.
 *
 * `forOrderId` is excluded, on the same reasoning as `availabilityFor`: an
 * order re-running its own reservation must not see its own holding as a
 * competitor and reserve nothing.
 */
export async function piecesHeldByOthers(companyId, catalogItemId, { forOrderId = null, conn = null } = {}) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT DISTINCT stock_piece_id AS pieceId
       FROM fab_stock_reservations
      WHERE company_id = ? AND catalog_item_id = ? AND status = 'active'
        AND deleted_at IS NULL AND stock_piece_id IS NOT NULL
        AND NOT (? IS NOT NULL AND order_id <=> ?)`,
    [companyId, catalogItemId, forOrderId, forOrderId],
  );
  return new Set(rows.map((r) => Number(r.pieceId)));
}

/** The specific plates an order is holding for one item. */
export async function piecesReservedFor(companyId, orderId, catalogItemId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT stock_piece_id AS pieceId FROM fab_stock_reservations
      WHERE company_id = ? AND order_id = ? AND catalog_item_id = ?
        AND status = 'active' AND deleted_at IS NULL AND stock_piece_id IS NOT NULL`,
    [companyId, orderId, catalogItemId],
  );
  return rows.map((r) => Number(r.pieceId));
}

/**
 * Earmark SPECIFIC plates for an order, where the requirement names a size.
 *
 * This is the half of reservation that catalog-level quantities cannot express.
 * `reserveForOrder` answers "how much of item X is this order holding"; this
 * answers "which plates", which is the only question that means anything once
 * consumption matches on size.
 *
 * SAME ENGAGEMENT RULE AS CONSUMPTION, deliberately. Nothing is earmarked
 * unless the requirement carries a size AND at least one in-stock piece of that
 * item has a recorded size. Otherwise there is nothing to distinguish one plate
 * from another, naming one would be arbitrary, and an arbitrary earmark is
 * worse than none — it would block another order from a plate for no reason.
 * The two rules have to agree, or an order could reserve a plate consumption
 * then refuses to take.
 *
 * @param {Array<{catalogItemId:number, lengthMm:number|null, widthMm:number|null, plates:number}>} wants
 * @returns {Promise<Array<{catalogItemId:number, pieceIds:number[], short:number}>>}
 */
export async function reservePiecesForOrder(conn, companyId, orderId, wants) {
  const exec = conn ?? pool;
  const out = [];

  for (const w of wants) {
    const id = Number(w.catalogItemId);
    const need = Math.max(1, Number(w.plates) || 1);
    if (!Number.isFinite(id)) continue;
    if (w.lengthMm == null && w.widthMm == null) continue;

    const [[m]] = await exec.query(
      `SELECT COUNT(*) AS measured FROM fab_stock_pieces
        WHERE company_id = ? AND catalog_item_id = ? AND status = 'in_stock'
          AND deleted_at IS NULL AND qty > 0
          AND (length_mm IS NOT NULL OR width_mm IS NOT NULL)`,
      [companyId, id],
    );
    if (!(Number(m?.measured) > 0)) continue; // dormant, exactly as consumption is

    const heldByOthers = await piecesHeldByOthers(companyId, id, { forOrderId: orderId, conn: exec });

    /**
     * Candidate plates of exactly the declared size, oldest first — the same
     * ordering consumption uses, so the plate reserved is the plate taken.
     *
     * Matched on FIELD VALUES rather than the projected columns, and it has to
     * stay identical to `wipInventoryService.consumeStock` down to the NULL
     * handling: if reservation and consumption disagree about which plates
     * qualify, an order earmarks one plate and is handed another, which is the
     * exact failure piece-level reservation exists to prevent. Both now build
     * the filter from the same `fieldMatchSql`, so they cannot drift apart by
     * one of them being edited.
     */
    const match = await fieldMatchSql(companyId, 'stock_piece', 'p',
      { length_mm: w.lengthMm ?? null, width_mm: w.widthMm ?? null }, exec);

    const [candidates] = await exec.query(
      `SELECT p.id FROM fab_stock_pieces p
       ${match.join}
        WHERE p.company_id = ? AND p.catalog_item_id = ? AND p.status = 'in_stock'
          AND p.deleted_at IS NULL AND p.qty > 0${match.where}
        ORDER BY (p.received_date IS NULL), p.received_date ASC, p.id ASC
        FOR UPDATE`,
      [...match.joinParams, companyId, id, ...match.whereParams],
    );

    const picked = candidates
      .map((c) => Number(c.id))
      .filter((pid) => !heldByOthers.has(pid))
      .slice(0, need);

    // Replace this order's own piece-level holding for the item rather than
    // stacking a second one — pressing the button twice must not hold twice the
    // steel, which is the same rule reserveForOrder follows.
    await exec.query(
      `UPDATE fab_stock_reservations
          SET status = 'released', released_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND catalog_item_id = ?
          AND kind = 'order' AND status = 'active' AND deleted_at IS NULL
          AND stock_piece_id IS NOT NULL`,
      [companyId, orderId, id],
    );

    for (const pid of picked) {
      await exec.query(
        `INSERT INTO fab_stock_reservations
           (company_id, catalog_item_id, stock_piece_id, kind, order_id, qty, status, notes)
         VALUES (?, ?, ?, 'order', ?, 1, 'active', ?)`,
        [companyId, id, pid, orderId,
         `plate ${w.lengthMm ?? '?'}x${w.widthMm ?? '?'} earmarked for this order`],
      );
    }

    out.push({ catalogItemId: id, pieceIds: picked, short: Math.max(0, need - picked.length) });
  }
  return out;
}
