/**
 * remnantService.js — what is left of a plate after the nest comes off it.
 *
 * A drop is steel the shop has already paid for. Until now it left the system
 * entirely: a plate was consumed whole, and whatever was still attached to it
 * became invisible the moment it was cut. This records it as stock, with its
 * size and where it came from, so the next job can be nested onto it.
 *
 * ── WHERE THE SHAPE COMES FROM ────────────────────────────────────────────
 * The packer's leftover free rectangles. That is not a convenience — it is the
 * reason the numbers mean anything: they are GUILLOTINE rectangles, produced by
 * the same edge-to-edge splits the cutter will actually make, so each one is a
 * piece that can genuinely be lifted off the table. An area figure ("38% of the
 * plate remains") would be arithmetically true and physically useless, because
 * it says nothing about whether that 38% is one usable sheet or a fringe.
 *
 * The nest's own layout is re-derived here rather than stored, so a plate
 * nested by hand, by spreadsheet, or by the suggestor all yield drops the same
 * way. The layout a hand-nester had in mind may differ from this one; what does
 * not differ is the plate, the parts on it, and therefore roughly what is left.
 *
 * ── ESTIMATED, AND SAID SO ────────────────────────────────────────────────
 * Every drop written here is marked `dims_estimated`. It is computed from an
 * ideal layout minus a kerf allowance, and the real one is whatever the torch
 * did. Marking it is what lets somebody correct it from the stock screen
 * without the two claims — computed and measured — ever being confused.
 */

import { nest as packNest } from './nestingPacker.js';
import { ensurePieceCode } from './stockCodeService.js';
import { kerfFor } from './kerfService.js';

/**
 * Defaults, overridable per company in `fab_company_settings`.
 *
 * MIN_SHORT_MM / MIN_AREA_MM2: below this a drop is scrap, not stock. Tracking
 * every sliver fills the yard with pieces nobody will walk to and makes the
 * suggestor offer them. Roughly "big enough to be a stiffener or a cover
 * plate".
 *
 * KERF is NOT read from `remnant_kerf_mm` any more (PLAN.md EU-11 item 7):
 * that setting defaulted to 4 mm while the packer's own `kerfFor` (EU-10)
 * defaults to 2 — two numbers for one physical fact, so a drop computed after
 * a 2 mm pack was recorded 2 mm small on every edge. `recordNestDrops` below
 * resolves the plate's own kerf via `kerfFor` and passes it in instead.
 */
const DEFAULTS = {
  remnant_min_short_mm: 300,
  remnant_min_area_mm2: 500000, // 0.5 m²
};

export async function remnantSettings(conn, companyId) {
  const [rows] = await conn.query(
    `SELECT setting_key, setting_value FROM fab_company_settings
      WHERE company_id = ? AND deleted_at IS NULL AND setting_key IN (?)`,
    [companyId, Object.keys(DEFAULTS)],
  );
  const out = { ...DEFAULTS };
  for (const r of rows) {
    const n = Number(r.setting_value);
    if (Number.isFinite(n) && n >= 0) out[r.setting_key] = n;
  }
  return out;
}

/**
 * The usable drops left by one nest.
 *
 * @param {{length:number,width:number}} plate      the plate's own size
 * @param {Array<{key,length,width,qty}>} partRows  what is cut from it
 * @returns {{drops:Array<{length,width}>, scrapAreaMm2:number, usedAreaMm2:number}}
 */
export function dropsFor(plate, partRows, settings = DEFAULTS) {
  // `?? 2`: same last-resort as `kerfService`'s own blanket default, for a
  // caller (a script, a future test) that does not go through `recordNestDrops`
  // and so never had a real kerf resolved onto `settings`.
  const kerf = settings.remnant_kerf_mm ?? 2;
  const spec = { id: 0, code: 'plate', length: plate.length, width: plate.width };

  /**
   * Pack onto ONE plate and read the leftover rectangles off it.
   *
   * `packNest` will happily open a second plate for parts that do not fit, and
   * a second plate's leftovers are not this plate's drops — they are a plate
   * nobody bought. Only the first is read, and anything that spilled is simply
   * not our business here: this function answers "what is left of THIS plate".
   */
  const { plates } = packNest(partRows, [spec]);
  const first = plates[0];
  if (!first) return { drops: [], scrapAreaMm2: 0, usedAreaMm2: 0 };

  const usedAreaMm2 = first.rows.reduce((s, r) => s + r.length * r.width * r.qty, 0);
  const drops = [];
  let scrapAreaMm2 = 0;

  for (const r of first.free) {
    // Every free rectangle is bounded by cuts, so it loses a kerf on the sides
    // that were cut rather than milled. Taking one kerf off each axis is the
    // conservative reading and errs toward a drop that fits.
    const length = Math.max(0, r.l - kerf);
    const width = Math.max(0, r.w - kerf);
    const area = length * width;
    const short = Math.min(length, width);
    if (short >= settings.remnant_min_short_mm && area >= settings.remnant_min_area_mm2) {
      drops.push({ length, width, areaMm2: area });
    } else {
      scrapAreaMm2 += area;
    }
  }
  drops.sort((a, b) => b.areaMm2 - a.areaMm2);
  return { drops, scrapAreaMm2, usedAreaMm2 };
}

/**
 * The parts cut from one nest, as rows the packer understands.
 *
 * Reads the same structure everything else does: a material link is a childless
 * row carrying a catalog item and no flow, and its PARENT is the part.
 */
async function partsOnNest(conn, companyId, orderId, catalogItemId, nestNo) {
  const [rows] = await conn.query(
    `SELECT rm.id AS linkId, rm.length AS plateLength, rm.width AS plateWidth,
            rm.qty AS nestQty,
            p.id AS partId, p.code AS partCode, p.qty AS partQty,
            p.length AS partLength, p.width AS partWidth
       FROM fab_items rm
       JOIN fab_items p ON p.id = rm.parent_item_id AND p.deleted_at IS NULL
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.catalog_item_id = ?
        AND rm.nest_no = ? AND rm.deleted_at IS NULL
        -- The labelled test, not 'catalog item and no flow': a TYPED girder row
        -- also has both, and only its null nest_no keeps it out of here.
        AND rm.node_kind = 'material'`,
    [companyId, orderId, catalogItemId, nestNo],
  );
  const partRows = [];
  for (const r of rows) {
    const length = Number(r.partLength);
    const width = Number(r.partWidth);
    // A part with no recorded size cannot be laid out, so the drop cannot be
    // computed honestly either. Reported by the caller rather than guessed at.
    if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) return null;
    partRows.push({
      // The pieces of THIS part cut on THIS sheet — a part can be split across
      // several nests, so the link's own qty is what belongs here, not the
      // part's order-wide total. Falls back to partQty for a link written
      // before this contract (blank/zero qty), same as everywhere else.
      key: String(r.linkId), length, width, qty: Math.max(1, Number(r.nestQty ?? r.partQty) || 1),
    });
  }
  const plate = rows.length
    ? { length: Number(rows[0].plateLength), width: Number(rows[0].plateWidth) }
    : null;
  if (!plate || !Number.isFinite(plate.length) || !Number.isFinite(plate.width)) return null;
  return { plate, partRows };
}

/**
 * Book the drops of a nest into stock, on the caller's transaction.
 *
 * Called from the ONE place a plate is drawn — `claimNest` wins a unique index
 * per (order, material, nest), so this runs once per physical plate however
 * many parts come off it. Booking per part would create the same drop twenty
 * times.
 *
 * Best-effort by design: it returns a reason rather than throwing. A drop that
 * could not be computed is lost material, which is bad; a task that will not
 * START because a drop could not be computed is a stopped shop, which is worse.
 *
 * @returns {Promise<{created:number, pieces:Array, skipped?:string}>}
 */
export async function recordNestDrops(conn, companyId, {
  orderId, catalogItemId, nestNo, sourcePiece, plantId, stockLocationId,
}) {
  if (!nestNo || !catalogItemId || !orderId) return { created: 0, pieces: [], skipped: 'not a nest' };

  const settings = await remnantSettings(conn, companyId);
  const shape = await partsOnNest(conn, companyId, orderId, catalogItemId, nestNo);
  if (!shape) {
    return { created: 0, pieces: [], skipped: 'the nest has no recorded plate or part sizes' };
  }

  // The SAME kerf the pack itself used (`process:'cutting'`), not a second,
  // disagreeing number — see the DEFAULTS comment above.
  const [[plateRow]] = await conn.query(
    `SELECT thickness_mm AS thickness FROM fab_item_catalog WHERE id = ? AND company_id = ? LIMIT 1`,
    [catalogItemId, companyId],
  );
  const kerfMm = await kerfFor(companyId, plateRow?.thickness ?? null, 'cutting');

  const { drops, scrapAreaMm2 } = dropsFor(
    shape.plate, shape.partRows, { ...settings, remnant_kerf_mm: kerfMm },
  );
  if (!drops.length) {
    return { created: 0, pieces: [], skipped: 'nothing left above the keep-threshold', scrapAreaMm2 };
  }

  const pieces = [];
  for (const d of drops) {
    const [ins] = await conn.query(
      `INSERT INTO fab_stock_pieces
         (company_id, catalog_item_id, plant_id, stock_location_id, qty, uom, status,
          length_mm, width_mm, origin_piece_id, origin_nest_no, dims_estimated,
          received_date, notes, heat_no, batch_no, unit_cost)
       VALUES (?,?,?,?,1,?, 'in_stock', ?,?,?,?,1, UTC_DATE(), ?, ?, ?, ?)`,
      [
        companyId, catalogItemId, plantId, stockLocationId,
        sourcePiece?.uom ?? null,
        d.length, d.width,
        sourcePiece?.id ?? null, nestNo,
        `Offcut of ${nestNo}${sourcePiece?.code ? ` from ${sourcePiece.code}` : ''} — `
          + 'size computed from the nesting layout, not measured',
        // Provenance the yard cares about: a drop is the same heat as the plate
        // it came off, and losing that makes it untraceable for anything
        // certified.
        sourcePiece?.heat_no ?? null,
        sourcePiece?.batch_no ?? null,
        /**
         * Cost is NOT carried across.
         *
         * The plate's unit cost is the cost of the WHOLE plate; copying it onto
         * a drop would value a 0.8 m² offcut at the price of a 24 m² sheet and
         * inflate stock value every time anything was cut. Costing an offcut
         * properly is an accounting decision (is it free, is it pro-rata, is it
         * written down?) and not one to make silently here.
         */
        null,
      ],
    );
    await ensurePieceCode(conn, companyId, ins.insertId);
    pieces.push({ id: ins.insertId, length: d.length, width: d.width });
  }
  return { created: pieces.length, pieces, scrapAreaMm2 };
}
