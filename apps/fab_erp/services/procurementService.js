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
import { availabilityFor, availabilityBySize, sizeKey } from './availabilityService.js';
import { LINE_QTY_SQL } from './orderLineQty.js';

/**
 * ANCESTOR MULTIPLICITY, for bought parts that sit INSIDE the structure.
 *
 * A row's qty is per ONE parent: 120 shear studs under a segment, of which a
 * girder has three, of which a span has two, is 720 studs on the order — the
 * BOM screen and the fabrication draft already say "720 total". The buy side
 * summed the row's own 120 and multiplied by line qty alone, so anything
 * bought under a multi-qty assembly was under-ordered by the product of its
 * ancestors' quantities (studs directly under a Span, as on KEPL, were fine).
 *
 * `anc.mult` is the product of the qty of every row ABOVE a row (the root is
 * qty 1 by the rule in orderLineQty.js). It applies to STRUCTURE rows only: a
 * material link's qty carries its own meaning (see the un-nested branch below
 * — one draw per link), and nests are counted per plate, never multiplied.
 *
 * Prepend to a statement; it takes (company_id, order_id) as its first two
 * placeholders. `LEFT JOIN anc a ON a.id = fi.id` inside, then STRUCT_MULT_SQL.
 */
const ANCESTOR_MULT_CTE = `
  WITH RECURSIVE anc AS (
    SELECT id, qty, CAST(1 AS DECIMAL(18,4)) AS mult
      FROM fab_items
     WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND parent_item_id IS NULL
    UNION ALL
    SELECT c.id, c.qty, CAST(anc.mult * COALESCE(anc.qty, 1) AS DECIMAL(18,4))
      FROM fab_items c
      JOIN anc ON c.parent_item_id = anc.id
     WHERE c.deleted_at IS NULL
  )`;
const STRUCT_MULT_SQL = `(CASE WHEN fi.node_kind = 'structure' THEN COALESCE(a.mult, 1) ELSE 1 END)`;

/** The answer for a node with no catalog link, and the fallback for an unset one. */
export const DEFAULT_PROCUREMENT = 'make';

/**
 * What the shop can do with a thing. Anything else is not a procurement type.
 *
 * `free_issue` (EU-14) joins `make`/`buy`: material the CUSTOMER supplies. It
 * is deliberately excluded from every "what do we need to purchase" query
 * below — see `orderShortfall`'s `freeIssueLines` — while still being real
 * catalog-linked stock that the material gate checks for like any other.
 */
export const PROCUREMENT_TYPES = ['make', 'buy', 'free_issue'];

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
 * @param {{cache: Map}} [opts.ctx] EU-14 item E3: a per-REQUEST memo (shared
 *   across `productionPlanService.buyView`, `orderReadinessService`'s
 *   `summariseProcurement` and `procurementOrderService.requestProcurement`)
 *   so a screen or action that needs this more than once in one call does not
 *   join half a dozen tables twice. Keyed by orderId so one ctx handed to
 *   several orders in sequence (not a real caller today, but cheap to allow)
 *   never answers with someone else's order.
 * @returns {Promise<{buy: object[], buySizes: object[], make: object[], freeIssue: object[]}>}
 */
export async function orderProcurementSplit(companyId, orderId, conn, { ctx } = {}) {
  const cacheKey = `split:${orderId}`;
  if (ctx?.cache?.has(cacheKey)) return ctx.cache.get(cacheKey);
  const exec = conn ?? pool;

  // Re-mirror before reading: syncOrderProcurement otherwise only runs on a
  // structure write, so a catalog item flipped to free_issue (or buy/make)
  // AFTER an order's parts were materialized would read stale here forever —
  // the Buy screen and the shortfall it drives must see today's catalog, not
  // the day the row was built.
  await syncOrderProcurement(exec, companyId, orderId);

  /**
   * A NEST IS ONE PLATE, PERIOD (User Clarifications 1 + EU-4). `fi.qty` on a
   * material link is PIECES of the part cut from that nest, never a plate
   * count — so the un-nested and nested branches below answer different
   * questions and must not be merged into one CASE.
   *
   * UN-NESTED (`nest_no IS NULL`): each row is its own draw, one item at a
   * time. The order needs this row's steel LINE_QTY times over — that is the
   * ONE place in this branch the line-qty multiply happens (User
   * Clarifications 3), and `order_line_id` has to survive into the GROUP BY
   * so the right line's qty is the one that gets applied.
   *
   * NESTED (`nest_no IS NOT NULL`, User Clarifications 5 — supersedes the
   * pre-EU-4 blank-only special case that used to sit here): the DEMAND fed
   * into nesting was already multiplied by line qty before the packer ran
   * (`blankService.orderBlanks`), so a qty-3 line's pieces are already laid
   * out together on shared sheets. Plates needed is therefore simply the
   * DISTINCT NESTS this catalog item occupies — one plate per nest, full stop
   * — never `MAX(fi.qty)` (that reads a PIECE count, not a plate count, since
   * EU-4) and never multiplied by line qty again (that would count every
   * unit's steel a second time). Weight is taken once per nest the same way:
   * `MAX(fi.total_weight)` is the PLATE's own weight, identical on every link
   * that shares it.
   */
  const [buy] = await exec.query(
    `${ANCESTOR_MULT_CTE}
     SELECT t.catalog_item_id, fic.code, fic.name, fic.unit,
            SUM(t.lines_count) AS lines_count, SUM(t.qty) AS qty,
            SUM(t.total_weight) AS total_weight
       FROM (
         SELECT fi.catalog_item_id,
                COUNT(*) AS lines_count,
                -- CAST back to fab_items.qty's own scale: multiplying two
                -- DECIMALs adds their scales (4+4=8), which changes nothing
                -- numerically but reformats "8.0000" as "8.00000000" even at
                -- the default line qty of 1 — a byte-for-byte snapshot diff
                -- on every order with no multi-qty line, for no reason.
                CAST(SUM(fi.qty * ${STRUCT_MULT_SQL}) * ${LINE_QTY_SQL} AS DECIMAL(18,4)) AS qty,
                CAST(SUM(fi.total_weight * ${STRUCT_MULT_SQL}) * ${LINE_QTY_SQL} AS DECIMAL(18,6)) AS total_weight
           FROM fab_items fi
           LEFT JOIN fab_order_lines fol ON fol.id = fi.order_line_id AND fol.deleted_at IS NULL
           LEFT JOIN anc a ON a.id = fi.id
          WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
            AND COALESCE(fi.procurement_type, ?) = 'buy' AND fi.nest_no IS NULL
          GROUP BY fi.catalog_item_id, fi.order_line_id

          UNION ALL

         SELECT fi.catalog_item_id,
                COUNT(*) AS lines_count,
                1 AS qty,
                MAX(fi.total_weight) AS total_weight
           FROM fab_items fi
          WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
            AND COALESCE(fi.procurement_type, ?) = 'buy' AND fi.nest_no IS NOT NULL
          GROUP BY fi.catalog_item_id, fi.nest_no
       ) t
       LEFT JOIN fab_item_catalog fic ON fic.id = t.catalog_item_id
      GROUP BY t.catalog_item_id, fic.code, fic.name, fic.unit
      ORDER BY fic.code`,
    [companyId, orderId, companyId, orderId, DEFAULT_PROCUREMENT, companyId, orderId, DEFAULT_PROCUREMENT],
  );

  // The same buy side broken down by the PLATE SIZE each row asks for.
  //
  // The grouping above collapses every nest of an item into one number, so ten
  // nests of ten different sizes read as "10 of catalog item N" and any ten
  // pieces of it look like enough. The sizes are what nesting decided
  // (fab_items.length/width and `height` = thickness on the material link), and
  // they are the thing that has to be matched against the yard.
  const [buySizes] = await exec.query(
    `${ANCESTOR_MULT_CTE}
     SELECT t.catalog_item_id, t.length, t.width, t.height,
            SUM(t.lines_count) AS lines_count, SUM(t.qty) AS qty
       FROM (
         SELECT fi.catalog_item_id, fi.length, fi.width, fi.height,
                COUNT(*) AS lines_count,
                CAST(SUM(fi.qty * ${STRUCT_MULT_SQL}) * ${LINE_QTY_SQL} AS DECIMAL(18,4)) AS qty
           FROM fab_items fi
           LEFT JOIN fab_order_lines fol ON fol.id = fi.order_line_id AND fol.deleted_at IS NULL
           LEFT JOIN anc a ON a.id = fi.id
          WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
            AND COALESCE(fi.procurement_type, ?) = 'buy'
            AND fi.catalog_item_id IS NOT NULL AND fi.nest_no IS NULL
          GROUP BY fi.catalog_item_id, fi.length, fi.width, fi.height, fi.order_line_id

          UNION ALL

         SELECT fi.catalog_item_id, fi.length, fi.width, fi.height,
                COUNT(*) AS lines_count,
                1 AS qty
           FROM fab_items fi
          WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
            AND COALESCE(fi.procurement_type, ?) = 'buy'
            AND fi.catalog_item_id IS NOT NULL AND fi.nest_no IS NOT NULL
          GROUP BY fi.catalog_item_id, fi.length, fi.width, fi.height, fi.nest_no
       ) t
      GROUP BY t.catalog_item_id, t.length, t.width, t.height
      ORDER BY t.catalog_item_id, t.length, t.width`,
    [companyId, orderId, companyId, orderId, DEFAULT_PROCUREMENT, companyId, orderId, DEFAULT_PROCUREMENT],
  );

  // Untouched by EU-5: one row per made item, not an aggregate — `fi.qty` is
  // deliberately the row's own per-piece figure (as intended for a listing),
  // and there is no per-order sum here to multiply. `orderShortfall` — the
  // only caller of this function — never reads `make` at all.
  const [make] = await exec.query(
    `SELECT fi.id, fi.parent_item_id, fi.code, fi.name, fi.node_kind, fi.qty,
            fi.unit, fi.flow_id, fi.total_weight
       FROM fab_items fi
      WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
        AND COALESCE(fi.procurement_type, ?) = 'make'
      ORDER BY fi.id`,
    [companyId, orderId, DEFAULT_PROCUREMENT],
  );

  /**
   * Free-issue material, split out from `buy` on purpose (User Clarifications
   * / EU-14 item 1): the customer supplies it, so it must never reach
   * `orderShortfall`'s purchasable `lines` — a purchase request built off that
   * array would ask a supplier for steel the customer is already sending.
   * Same UNION shape as `buy` (a nested link is one plate, an un-nested row is
   * LINE_QTY_SQL pieces) purely so the figures `orderShortfall` reports for a
   * free-issue item (required, size) mean the same thing they mean for a
   * bought one — the DIFFERENCE is what happens to the number afterward, not
   * how it is added up.
   */
  const [freeIssue] = await exec.query(
    `SELECT t.catalog_item_id, fic.code, fic.name, fic.unit,
            SUM(t.lines_count) AS lines_count, SUM(t.qty) AS qty,
            SUM(t.total_weight) AS total_weight
       FROM (
         SELECT fi.catalog_item_id,
                COUNT(*) AS lines_count,
                CAST(SUM(fi.qty) * ${LINE_QTY_SQL} AS DECIMAL(18,4)) AS qty,
                CAST(SUM(fi.total_weight) * ${LINE_QTY_SQL} AS DECIMAL(18,6)) AS total_weight
           FROM fab_items fi
           LEFT JOIN fab_order_lines fol ON fol.id = fi.order_line_id AND fol.deleted_at IS NULL
          WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
            AND fi.procurement_type = 'free_issue' AND fi.nest_no IS NULL
          GROUP BY fi.catalog_item_id, fi.order_line_id

          UNION ALL

         SELECT fi.catalog_item_id,
                COUNT(*) AS lines_count,
                1 AS qty,
                MAX(fi.total_weight) AS total_weight
           FROM fab_items fi
          WHERE fi.company_id = ? AND fi.order_id = ? AND fi.deleted_at IS NULL
            AND fi.procurement_type = 'free_issue' AND fi.nest_no IS NOT NULL
          GROUP BY fi.catalog_item_id, fi.nest_no
       ) t
       LEFT JOIN fab_item_catalog fic ON fic.id = t.catalog_item_id
      GROUP BY t.catalog_item_id, fic.code, fic.name, fic.unit
      ORDER BY fic.code`,
    [companyId, orderId, companyId, orderId],
  );

  const result = { buy, buySizes, make, freeIssue };
  if (ctx?.cache) ctx.cache.set(cacheKey, result);
  return result;
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
 * FREE-ISSUE (EU-14) never enters `lines`/`shortCount` at all — the customer
 * supplies it, so nothing here may ever compute a `short` for it or feed it to
 * `procurementOrderService.requestProcurement`'s purchase-request logic. It
 * comes back separately, as `freeIssueLines`, purely so a screen can still
 * SHOW what is free-issued (EU-14 item 3 / the production plan's Buy section)
 * without it ever being purchasable.
 *
 * @param {{cache: Map}} [opts.ctx] EU-14 item E3 — see `orderProcurementSplit`.
 * @returns {Promise<{lines: object[], unmatched: object[], shortCount: number,
 *   freeIssueLines: object[]}>}
 */
export async function orderShortfall(companyId, orderId, conn, { ctx } = {}) {
  const cacheKey = `shortfall:${orderId}`;
  if (ctx?.cache?.has(cacheKey)) return ctx.cache.get(cacheKey);
  const { buy, buySizes, freeIssue } = await orderProcurementSplit(companyId, orderId, conn, { ctx });

  const unmatched = buy.filter((r) => r.catalog_item_id == null);
  const matched = buy.filter((r) => r.catalog_item_id != null);

  const avail = await availabilityFor(
    companyId, matched.map((r) => r.catalog_item_id), { forOrderId: orderId, conn },
  );

  // Size-aware availability for every distinct plate size the order asks for.
  const sizeAvail = await availabilityBySize(
    companyId,
    (buySizes || []).map((r) => ({
      catalogItemId: r.catalog_item_id, length: r.length, width: r.width,
    })),
    { conn },
  );

  const sizesByItem = new Map();
  for (const r of buySizes || []) {
    const id = Number(r.catalog_item_id);
    const a = sizeAvail.get(sizeKey(id, r.length, r.width)) || { onHand: 0, unsized: 0 };
    const required = Number(r.qty) || 0;
    // A row with no size recorded cannot be size-matched — there is nothing to
    // compare — so it falls back to the catalog-level answer further down.
    const sized = r.length != null || r.width != null;
    const row = {
      thick: r.height == null ? null : Number(r.height),
      length: r.length == null ? null : Number(r.length),
      width: r.width == null ? null : Number(r.width),
      required,
      onHand: a.onHand,
      unsized: a.unsized,
      sized,
      short: sized ? Math.max(0, required - a.onHand) : null,
    };
    if (!sizesByItem.has(id)) sizesByItem.set(id, []);
    sizesByItem.get(id).push(row);
  }

  const lines = matched.map((r) => {
    const id = Number(r.catalog_item_id);
    const a = avail.get(id) || { onHand: 0, reserved: 0, available: 0 };
    const required = Number(r.qty) || 0;
    const sizes = sizesByItem.get(id) ?? [];

    /**
     * Shortfall, size by size where a size is known.
     *
     * Rows whose plate size was never filled in still fall back to the
     * catalog-level comparison, so an order that has not been nested yet
     * behaves exactly as it did before rather than suddenly reading as
     * entirely short.
     *
     * Reservations stay a catalog-level figure and are NOT netted off a
     * specific size: a reservation records "this order has claimed N of item X"
     * and cannot say which physical plate, so attributing it to one size would
     * be inventing information. It is reported on the line for context.
     */
    const sizedRows = sizes.filter((s) => s.sized);
    const unsizedRequired = sizes.filter((s) => !s.sized)
      .reduce((n, s) => n + s.required, 0);

    /**
     * STOCK NOBODY MEASURED STILL COUNTS, and leaving it out ordered a yard
     * full of steel a second time.
     *
     * Size matching compares a requirement against pieces carrying the same
     * length and width. A piece whose size was never recorded matches nothing,
     * so an item whose stock is all unmeasured read as ENTIRELY short: 14,424
     * shear studs required, 14,424 on hand, and a purchase order for 14,424
     * more. The unsized figure was already being computed and reported on the
     * line — it just never reduced anything.
     *
     * It is safe to draw on because a catalogue item now NAMES its size — "MS
     * Plate 28 x 3100 x 12050" — so a full piece of that item IS that size
     * whether or not somebody typed the dimensions onto the piece. That was not
     * true when an item meant only a thickness, which is where the caution came
     * from.
     *
     * OFFCUTS ARE NOT IN THIS POOL and must never be: a drop is smaller than
     * the item it came off, and it is created with its dimensions, so it is
     * always sized and always matched exactly. That is what stops this from
     * quietly under-ordering.
     *
     * Drawn down ONCE across the item's sizes, then what remains is what the
     * unsized requirements can still draw on — otherwise the same pieces would
     * be spent twice.
     */
    const unsizedPool = sizes.reduce((n, s) => Math.max(n, s.unsized), 0);
    const rawSizedShort = sizedRows.reduce((n, s) => n + (s.short || 0), 0);
    const drawnFromUnsized = Math.min(rawSizedShort, unsizedPool);
    const sizedShort = rawSizedShort - drawnFromUnsized;
    const unsizedShort = Math.max(0, unsizedRequired - Math.max(0, a.available - drawnFromUnsized));
    const short = sizedRows.length
      ? sizedShort + unsizedShort
      : Math.max(0, required - a.available);

    return {
      catalogItemId: id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      // EU-14 item E4: every buy-side line now says what kind of buy it is, so
      // the production plan's Buy section can render itself without a second
      // lookup. Always 'buy' here — `freeIssueLines` below carries the other kind.
      procurementType: 'buy',
      linesCount: Number(r.lines_count) || 0,
      required,
      onHand: a.onHand,
      reserved: a.reserved,
      available: a.available,
      short,
      sizes,
      /** Pieces of this item in stock whose size nobody recorded. */
      unsizedOnHand: sizes.reduce((n, s) => Math.max(n, s.unsized), 0),
    };
  }).sort((x, y) => (y.short - x.short) || String(x.code || '').localeCompare(String(y.code || '')));

  // EU-14 item 1: what the customer is supplying, shaped just enough like
  // `lines` for a screen to list it alongside — never a `short`, because a
  // free-issue item is never something this order buys.
  const freeIssueLines = (freeIssue || [])
    .filter((r) => r.catalog_item_id != null)
    .map((r) => ({
      catalogItemId: Number(r.catalog_item_id),
      code: r.code,
      name: r.name,
      unit: r.unit,
      procurementType: 'free_issue',
      linesCount: Number(r.lines_count) || 0,
      required: Number(r.qty) || 0,
    }));

  const result = {
    lines,
    unmatched: unmatched.map((r) => ({
      name: r.name, linesCount: Number(r.lines_count) || 0, required: Number(r.qty) || 0,
    })),
    shortCount: lines.filter((l) => l.short > 0).length,
    freeIssueLines,
  };
  if (ctx?.cache) ctx.cache.set(cacheKey, result);
  return result;
}
