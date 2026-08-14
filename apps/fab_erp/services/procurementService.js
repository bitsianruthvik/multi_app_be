/**
 * procurementService.js — one definition of "does the shop MAKE this or BUY it".
 *
 * The rule, for any node in an order's BOM:
 *
 *   linked to a catalog item  →  whatever the CATALOG says. The catalog is the
 *                                authority, which is what "explicitly selected
 *                                from the item catalog" means. Raw materials
 *                                come out 'buy' through this branch rather than
 *                                by being named specially anywhere — they are
 *                                catalog items whose procurement_type is 'buy',
 *                                and nothing here needs to know the word.
 *
 *   no catalog link           →  'make'. The structural levels of a BOQ — span,
 *                                girder, segment, part — are things this shop
 *                                builds. Nobody sells a girder for this bridge.
 *
 * Before this, only the catalog answered the question at all, so the structural
 * levels answered nothing: 230 of them in production, unclassified. "Raise a PO
 * for what we buy and a production order for what we make" cannot be asked of
 * data where most rows are silent, which is why this exists now rather than
 * alongside the step that will consume it.
 *
 * NULL means "never classified" and is treated as 'make' on read. It is not the
 * same as a stored 'make': the sweeps below fill NULLs but never overwrite a
 * value somebody chose, so the column can carry an override later without the
 * next deploy quietly undoing it.
 */

import { pool } from '../../../db.js';
import { availabilityFor } from './availabilityService.js';

/** The answer for a node with no catalog link, and the fallback for an unset one. */
export const DEFAULT_PROCUREMENT = 'make';

/** What the shop can do with a thing. Anything else is not a procurement type. */
export const PROCUREMENT_TYPES = ['make', 'buy'];

/**
 * The rule itself, for one row already in hand.
 *
 * @param {{catalogProcurementType?: string|null}} row - the item's catalog
 *   procurement_type if it is linked to one, null/undefined if it is not.
 * @returns {'make'|'buy'}
 */
export function procurementFor({ catalogProcurementType } = {}) {
  const t = catalogProcurementType == null ? null : String(catalogProcurementType).trim();
  return PROCUREMENT_TYPES.includes(t) ? t : DEFAULT_PROCUREMENT;
}

/** Reading an item that predates the column, or one nothing has classified. */
export const procurementOf = (item) => item?.procurement_type || DEFAULT_PROCUREMENT;

/**
 * Classify every node of one order, after items have been created or changed.
 *
 * Called once per import rather than threaded through each INSERT: fab_items is
 * written from six different places, and a field set six times is a field that
 * disagrees with itself six ways. One sweep at the end of an import is one
 * statement of the rule.
 *
 * Catalog-linked rows are re-mirrored every sweep — repointing an item at a
 * different catalog entry has to carry its procurement across. Uncatalogued
 * rows are only filled when blank, so an override survives.
 *
 * @param {object} conn - the caller's transaction; imports are transactional
 * @param {number} companyId
 * @param {number} orderId
 */
export async function syncOrderProcurement(conn, companyId, orderId) {
  const exec = conn ?? pool;

  await exec.query(
    `UPDATE fab_items fi
       JOIN fab_item_catalog fic
         ON fic.id = fi.catalog_item_id AND fic.deleted_at IS NULL
        SET fi.procurement_type = fic.procurement_type
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND (fi.procurement_type IS NULL OR fi.procurement_type <> fic.procurement_type)`,
    [companyId, orderId],
  );

  await exec.query(
    `UPDATE fab_items fi
        SET fi.procurement_type = ?
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND fi.catalog_item_id IS NULL AND fi.procurement_type IS NULL`,
    [DEFAULT_PROCUREMENT, companyId, orderId],
  );
}

/**
 * What an order needs bought and what it needs made — the shape the next step
 * wants: match `buy` against stock and raise POs for the shortfall, raise
 * production orders for `make`.
 *
 * Grouped by catalog item for the buy side because ten parts cut from the same
 * plate are one purchase, not ten.
 *
 * @returns {Promise<{buy: object[], make: object[]}>}
 */
export async function orderProcurementSplit(companyId, orderId, conn) {
  const exec = conn ?? pool;

  const [buy] = await exec.query(
    `SELECT fi.catalog_item_id, fic.code, fic.name, fic.unit,
            COUNT(*) AS lines_count, SUM(fi.qty) AS qty, SUM(fi.total_weight) AS total_weight
       FROM fab_items fi
       LEFT JOIN fab_item_catalog fic ON fic.id = fi.catalog_item_id
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND COALESCE(fi.procurement_type, ?) = 'buy'
      GROUP BY fi.catalog_item_id, fic.code, fic.name, fic.unit
      ORDER BY fic.code`,
    [companyId, orderId, DEFAULT_PROCUREMENT],
  );

  const [make] = await exec.query(
    `SELECT fi.id, fi.parent_item_id, fi.code, fi.name, fi.level_kind, fi.qty,
            fi.unit, fi.flow_id, fi.total_weight
       FROM fab_items fi
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND COALESCE(fi.procurement_type, ?) = 'make'
      ORDER BY fi.id`,
    [companyId, orderId, DEFAULT_PROCUREMENT],
  );

  return { buy, make };
}

/**
 * What this order needs to buy, against what the shelf can actually cover.
 *
 * One row per catalog item on the buy side:
 *
 *   required   how much of it this order's BOM consumes
 *   onHand     pieces standing in a stock area
 *   reserved   already earmarked by SOMEBODY ELSE (this order's own holding is
 *              excluded — it has that stock, and counting it would send the
 *              order out to buy what it is already holding)
 *   available  onHand − reserved
 *   short      required − available, floored at zero. This, and only this, is
 *              what a purchase order is raised for.
 *
 * A buy row with NO catalog item cannot be purchased or counted against stock —
 * there is nothing to match on. Those are returned separately rather than
 * folded into the totals, because silently dropping them would understate the
 * shortfall and quietly under-order.
 *
 * @returns {Promise<{lines: object[], unmatched: object[], shortCount: number}>}
 */
export async function orderShortfall(companyId, orderId, conn) {
  const { buy } = await orderProcurementSplit(companyId, orderId, conn);

  const unmatched = buy.filter((r) => r.catalog_item_id == null);
  const matched = buy.filter((r) => r.catalog_item_id != null);

  const avail = await availabilityFor(
    companyId, matched.map((r) => r.catalog_item_id), { forOrderId: orderId, conn },
  );

  const lines = matched.map((r) => {
    const id = Number(r.catalog_item_id);
    const a = avail.get(id) || { onHand: 0, reserved: 0, available: 0 };
    const required = Number(r.qty) || 0;
    return {
      catalogItemId: id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      linesCount: Number(r.lines_count) || 0,
      required,
      onHand: a.onHand,
      reserved: a.reserved,
      available: a.available,
      short: Math.max(0, required - a.available),
    };
  }).sort((x, y) => (y.short - x.short) || String(x.code || '').localeCompare(String(y.code || '')));

  return {
    lines,
    unmatched: unmatched.map((r) => ({
      name: r.name, linesCount: Number(r.lines_count) || 0, required: Number(r.qty) || 0,
    })),
    shortCount: lines.filter((l) => l.short > 0).length,
  };
}
