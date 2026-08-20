/**
 * 05-stock.mjs — opening stock, SIZED.
 *
 * WHY THIS MODULE IS NOT "just insert some rows".
 * ----------------------------------------------
 * The Placebo tenant that was wiped held 173 stock pieces and not one of them
 * carried a length or a width. That single omission broke the whole material
 * chain, and it broke it silently:
 *
 *   - `itemMaterialService.plateDimsForMaterial` assumes a part's plate size
 *     from the sizes actually held in the yard, and requires BOTH length and
 *     width to be non-null. With none, it returned nulls.
 *   - `nestingIntegrityService` then reported every part as NOT_NESTED_YET —
 *     "no sized stock of X is on hand to assume a plate size from".
 *   - `availabilityService.availabilityBySize` counts unsized pieces in a
 *     separate `unsized` bucket and NEVER as a match, so on-hand against any
 *     sized requirement was zero.
 *
 * Net effect in production: procurement declined every order by default and a
 * purchase order could only be raised with an explicit override, while the yard
 * was full of steel. No backfill could repair it either — no source anywhere
 * recorded what size those plates were.
 *
 * So the rule for this module is absolute: **every plate and every section is
 * created with a real length and a real width.** Consumables and spares are the
 * only exception and the reasoning for them is spelled out at CONSUMABLE_QTY.
 *
 * HOW IT WRITES: THROUGH `receiveStock`, NOT THROUGH INSERT.
 * ---------------------------------------------------------
 * `services/stockInService.receiveStock` is the application's own receipt path
 * and it takes an outer connection, so this module joins the runner's single
 * transaction rather than opening its own. Going through it is what gets us,
 * for free and identically to a human doing goods-in on the screen:
 *
 *   1. the piece CODE, minted by `codegenService.generateCode` on this same
 *      connection, so a rolled-back seed leaves no hole in the SP- sequence;
 *   2. the `fab_stock_ledger` row, with `piece_code` AND a real `batch_code`
 *      (BUG-19: the batch column must carry a batch, never the piece's code);
 *   3. the size written through `fieldService.setFields`, so the field values
 *      and the projected `fab_stock_pieces.length_mm` / `width_mm` columns are
 *      written together and cannot disagree.
 *
 * Hand-rolled INSERTs are how the old data got into the state described above.
 * We do not do that here, and we do not tolerate a half-success either: if
 * `receiveStock` reports ANY `dimensionRejections`, this module throws and the
 * runner rolls the whole rebuild back. A silently sizeless piece is the exact
 * failure this module exists to prevent, so it must never survive a green run.
 *
 * IDEMPOTENCE KEY: THE BATCH NUMBER.
 * ----------------------------------
 * Stock is the easiest thing in the rebuild to double, because nothing about a
 * second plate of 16 mm looks wrong. Pieces have no natural key of their own —
 * their `code` is minted fresh on every call, so it can never identify "the
 * same receipt twice".
 *
 * A BATCH does. Steel genuinely arrives in lots, many pieces to a lot, and
 * `batch_no` already exists on both the piece and the ledger row. So every lot
 * this module creates is stamped with a batch number WE control and can
 * recompute deterministically:
 *
 *     OPEN-<catalog code>-<length>x<width>      e.g. OPEN-RM-0008-12000x2400
 *     OPEN-<catalog code>                       (consumables/spares, no size)
 *
 * Before creating a lot we ask whether any live piece already carries that
 * batch. If one does, the lot is skipped whole. That makes a re-run create
 * exactly nothing, makes a half-finished run safe to repeat lot by lot, and
 * leaves a batch code on screen that says out loud where the stock came from.
 *
 * WHY THE PROFILE IS KEYED ON THE ITEM'S **NAME**.
 * ------------------------------------------------
 * Item ids are forbidden here for the obvious reason, and the item CODE would
 * be the natural alternative — but module 02 does not choose its codes. It
 * mints them through `codegenService.generateCode`, so an item's code
 * (`RM-0008`) is whatever the company's running sequence happened to be at the
 * moment it was created, and is not knowable when this file is written. Module
 * 02's own natural key is the NAME, enforced by `uq_fic2_company_name_active`,
 * and that is the same key used here so the two modules cannot drift apart.
 *
 * The minted code is still used — for the batch number — because once an item
 * exists its code is stable, and a batch that reads `OPEN-RM-0008-12000x2400`
 * is far easier to trace on the Stock screen than one built from a long name.
 *
 * @see FAB_ERP_PLACEBO_REBUILD_PLAN.md §"9. opening stock, sized"
 */

import { receiveStock } from '../../apps/fab_erp/services/stockInService.js';

export const NAME = 'Opening stock';

/**
 * Dated as an opening balance rather than "today", so a re-run, a restore and a
 * report all agree. `received_date` also drives FIFO consumption in
 * `wipInventoryService.consumeStock`, so it must be a real date — NULL sorts
 * last and would have opening stock consumed after everything received since.
 */
const OPENING_DATE = '2026-08-01';

const BATCH_PREFIX = 'OPEN';

/** Assumed landed rate, only used to give the pieces a plausible stock value. */
const RATE_INR_PER_KG = 68;

/** Density fallback when the catalog item does not carry one. Mild steel. */
const DEFAULT_DENSITY = 7850;

/**
 * The Raw Material Warehouse, by code, in preference order.
 *
 * `WH01` is the code in the rebuilt tenant. `RM-YARD` is what the same place is
 * called in the older local database, and naming it here is what lets this
 * module be verified locally without pretending the two tenants are identical.
 */
const WAREHOUSE_CODES = ['WH01', 'WH-01', 'RM-YARD', 'RM-STORE'];

/**
 * Areas that must never receive raw material, whatever else matches.
 *
 * `WIP-M<id>` is a MACHINE's own work-in-progress area (see
 * `wipInventoryService.ensureMachineArea`) — steel appears there because a task
 * moved it there, and seeding into one would fabricate a shop-floor state that
 * never happened. `MACH-*` and `FG-*` are equally wrong for incoming plate.
 */
const FORBIDDEN_LOCATION = /^(WIP-|MACH-|FG-)/i;

/**
 * THE STOCK PROFILE — what the yard holds on day one, and why.
 *
 * Sizes are the ones Indian fabrication shops actually buy: 12000×2400 and
 * 12000×2000 mill plate, with 6000×2000 as the short-length stock every yard
 * also carries. Quantities are sized so a 2-girder × 2-segment order
 * (1 span → 2 girders → 2 segments each → 7 parts a segment) can be satisfied
 * without a purchase order.
 *
 * ONE SIZE DOMINATES EACH THICKNESS, DELIBERATELY. `plateDimsForMaterial`
 * assumes the size the yard holds MOST pieces of, and `availabilityBySize`
 * then matches on that size EXACTLY. Spreading a thickness evenly across two
 * sizes would halve the on-hand count against the assumed size and invent a
 * shortage out of nothing. So each thickness has a clear majority size plus a
 * smaller holding of a second size, which is both realistic and safe.
 *
 * THE SHORTAGE IS ON PURPOSE — see `short` on the 45 mm line.
 */
const PLATE_PROFILE = [
  {
    name: 'MS Plate 16mm E350 B0',
    why: 'web plates — the highest-volume plate on a girder',
    lots: [
      { length: 12000, width: 2400, pieces: 6 },
      { length: 6000, width: 2000, pieces: 2 },
    ],
  },
  {
    name: 'MS Plate 20mm E350 B0',
    why: 'intermediate stiffeners and light webs',
    lots: [
      { length: 12000, width: 2400, pieces: 4 },
      { length: 12000, width: 2000, pieces: 1 },
    ],
  },
  {
    name: 'MS Plate 28mm E350 B0',
    why: 'heavier stiffeners',
    lots: [
      { length: 12000, width: 2400, pieces: 3 },
    ],
  },
  {
    name: 'MS Plate 32mm E350 B0',
    why: 'flange plate — 4 flanges nest across a 2400-wide plate',
    lots: [
      { length: 12000, width: 2400, pieces: 4 },
      { length: 12000, width: 2000, pieces: 1 },
    ],
  },
  {
    name: 'MS Plate 40mm E350 B0',
    why: 'heavy flanges; bought 2000 wide, which is how thick plate normally comes',
    lots: [
      { length: 12000, width: 2000, pieces: 3 },
    ],
  },
  {
    name: 'MS Plate 45mm E350 B0',
    /**
     * DELIBERATELY SHORT — and short on QUANTITY, not on SIZE.
     *
     * A tenant where nothing is ever short cannot demonstrate procurement at
     * all, so one thickness has to fall short. Which one, and how, both matter:
     *
     *   WHICH: 45 mm is the thickest plate in the catalog and on a plate girder
     *   it is bearing-stiffener material — the least-used thickness of the six.
     *   Being short here puts ONE part type into procurement instead of
     *   stalling the whole order, which is what makes it a demonstration rather
     *   than a roadblock.
     *
     *   HOW: one plate at the FULL 12000×2400 size, not a small one. An
     *   undersized plate would make `plateDimsForMaterial` assume 6000×2000 for
     *   every 45 mm part and `nestingIntegrityService` would raise PART_TOO_BIG
     *   — a blocking geometry fault, not a shortage. With a correctly sized
     *   plate, nesting matches cleanly and `availabilityBySize` reports on-hand
     *   1 against a requirement of several: a plain quantity shortfall, which is
     *   exactly the signal procurement is built to act on.
     */
    why: 'bearing stiffeners — LEFT SHORT ON PURPOSE so procurement has something to buy',
    short: true,
    lots: [
      { length: 12000, width: 2400, pieces: 1 },
    ],
  },
];

/**
 * SECTIONS, and what `width_mm` means for one.
 *
 * A section is bought by LENGTH — 12 m standard mill length — and its "width"
 * is not a footprint the way a plate's is. The question is whether to leave
 * `width_mm` NULL, and the answer is a firm no, for a reason that is in the
 * code rather than in taste:
 *
 *   `plateDimsForMaterial` filters on `length_mm IS NOT NULL AND width_mm IS
 *   NOT NULL`. A section with a length but no width is invisible to it, so it
 *   would assume no size, and every part cut from that section would report
 *   NOT_NESTED_YET — the precise failure this whole module exists to prevent,
 *   reintroduced for the sections only.
 *
 * So width carries the section's LEG — 100 mm for an ISA 100×100×10, 75 mm for
 * the ISMC 200's flange. That is a real, checkable dimension of the piece (a
 * part cut from that angle is 100 mm across the leg), it makes the size pair
 * meaningful to `availabilityBySize`, and it is the number a storeman would
 * give if asked how wide the angle is.
 *
 * The alternative for a channel — calling its 200 mm DEPTH the width — was
 * rejected for consistency: the ISA's 100 is a leg, so the ISMC's should be a
 * flange, and one convention across all sections is worth more than each one
 * being individually arguable.
 */
const SECTION_PROFILE = [
  {
    name: 'ISA 100x100x10 E350 B0',
    why: 'equal angle — 12 m mill lengths; width_mm carries the 100 mm leg',
    lots: [
      { length: 12000, width: 100, pieces: 4 },
    ],
  },
  {
    name: 'ISMC 200 E350 B0',
    why: 'channel for cross-frames — 12 m lengths; width_mm carries the 75 mm flange',
    lots: [
      { length: 12000, width: 75, pieces: 3 },
    ],
  },
];

/**
 * Token opening quantity for something with no meaningful size.
 *
 * Welding wire, flux, zinc wire, grit, paint, drill bits, nozzles and contact
 * tips are consumed BY QUANTITY and never nested, so nothing ever asks
 * `availabilityBySize` for a 12000×2400 spool of wire. Their length and width
 * are left NULL because they genuinely have none — and unlike a plate, a NULL
 * here costs nothing: the `unsized` bucket in `availabilityBySize` exists for
 * exactly this, and no code path assumes a plate size from a consumable.
 *
 * Quantity is chosen from the item's own unit so the number reads sensibly
 * against it — 500 kg of flux, 200 litres of paint, 10 nos of drill bits.
 */
const CONSUMABLE_QTY = [
  { match: /^(kg|kgs|kilogram)/i, qty: 500 },
  { match: /^(l|lt|ltr|litre|liter)/i, qty: 200 },
  { match: /^(m|mtr|meter|metre)$/i, qty: 100 },
  { match: /^(nos|no|pcs|pc|ea|each|set)/i, qty: 10 },
];

/** Categories whose items get a token opening quantity rather than a size. */
const TOKEN_CATEGORIES = ['Consumables', 'MRO & Spares'];

const num = (v) => (v == null ? null : Number(v));

/** The batch number that IS this module's idempotence key. See the header. */
function batchCodeFor(itemCode, length, width) {
  const size = length == null && width == null ? '' : `-${length ?? 0}x${width ?? 0}`;
  return `${BATCH_PREFIX}-${itemCode}${size}`.slice(0, 60);
}

/** Mill-style heat number, deterministic from the piece's position in the plan. */
function heatNoFor(serial) {
  return `H2608-${String(serial).padStart(3, '0')}`;
}

/**
 * Landed value of one piece, from its own geometry — volume × density × rate.
 *
 * Plate volume is L×W×thickness; a section's is its `section_area_mm2` run
 * along its length. Both come off the catalog item, so an item that carries
 * neither simply gets no cost rather than an invented one.
 */
function unitCostFor(item, lot) {
  const density = num(item.density_kg_m3) || DEFAULT_DENSITY;
  let kg = null;

  if (item.section_area_mm2 != null && Number(item.section_area_mm2) > 0 && lot.length) {
    // m2 of section × metres of length × kg/m3
    kg = (Number(item.section_area_mm2) / 1e6) * (lot.length / 1000) * density;
  } else if (item.thickness_mm != null && lot.length && lot.width) {
    kg = (lot.length / 1000) * (lot.width / 1000) * (Number(item.thickness_mm) / 1000) * density;
  }

  if (kg == null || !Number.isFinite(kg) || kg <= 0) return null;
  return Math.round(kg * RATE_INR_PER_KG * 100) / 100;
}

/**
 * The leg width of a section whose NAME spells it out, e.g. "ISA 100x100x10".
 *
 * Only the full `AxBxC` designation is accepted. A looser pattern — any
 * trailing number — reads "RM-0014" as a 14 mm leg, and a wrong width is worse
 * than a defaulted one because it looks specific.
 */
function sectionWidthFromName(name) {
  const triple = String(name).toUpperCase().match(/(\d+)\s*X\s*(\d+)\s*X\s*(\d+)/);
  return triple ? Number(triple[1]) : null;
}

function tokenQtyFor(unit) {
  const u = String(unit ?? '').trim();
  for (const rule of CONSUMABLE_QTY) if (rule.match.test(u)) return rule.qty;
  return 10;
}

/** The Raw Material Warehouse — by code, never by id, and never a WIP area. */
async function findWarehouse(conn, companyId) {
  const [rows] = await conn.query(
    `SELECT id, code, name, plant_id
       FROM fab_stock_locations
      WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );

  for (const wanted of WAREHOUSE_CODES) {
    const hit = rows.find((r) => String(r.code).toUpperCase() === wanted.toUpperCase());
    if (hit) return hit;
  }

  /**
   * Last resort: a location that reads like a raw-material store and is
   * demonstrably not a machine area. Deliberately narrow — putting plate in the
   * wrong place is worse than failing loudly, so anything ambiguous falls
   * through to the error below.
   */
  const fallback = rows.find((r) => !FORBIDDEN_LOCATION.test(String(r.code))
    && /raw material|rm ?yard|warehouse|store/i.test(`${r.name} ${r.code}`));
  return fallback ?? null;
}

/** Catalog items by NAME, in one round trip. Never by id — see the header. */
async function itemsByName(conn, companyId, names) {
  if (!names.length) return new Map();
  const [rows] = await conn.query(
    `SELECT id, code, name, unit, thickness_mm, density_kg_m3, section_area_mm2,
            material_form, category_id
       FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND name IN (?)`,
    [companyId, names],
  );
  return new Map(rows.map((r) => [r.name, r]));
}

/** Every item sitting in one of the token categories, resolved by category NAME. */
async function tokenItems(conn, companyId) {
  const [rows] = await conn.query(
    `SELECT ic.id, ic.code, ic.name, ic.unit, ic.thickness_mm, ic.density_kg_m3,
            ic.section_area_mm2, ic.material_form, cat.name AS category
       FROM fab_item_catalog ic
       JOIN fab_item_categories cat
         ON cat.id = ic.category_id AND cat.company_id = ic.company_id
        AND cat.deleted_at IS NULL
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND cat.name IN (?)
      ORDER BY ic.code`,
    [companyId, TOKEN_CATEGORIES],
  );
  return rows;
}

/**
 * Raw materials the explicit profile above does not name.
 *
 * The rebuild plan allows for "one more section" whose code is module 02's to
 * choose, and an unstocked raw material is precisely the hole this module
 * exists to close — so anything found here is stocked on a documented default
 * rather than skipped, and the default used is logged by name.
 */
async function unprofiledRawMaterials(conn, companyId, knownNames) {
  const [rows] = await conn.query(
    `SELECT ic.id, ic.code, ic.name, ic.unit, ic.thickness_mm, ic.density_kg_m3,
            ic.section_area_mm2, ic.material_form
       FROM fab_item_catalog ic
       JOIN fab_item_categories cat
         ON cat.id = ic.category_id AND cat.company_id = ic.company_id
        AND cat.deleted_at IS NULL
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND cat.name = 'Raw Materials'
      ORDER BY ic.code`,
    [companyId],
  );
  return rows.filter((r) => !knownNames.has(r.name));
}

/** Live pieces already carrying a batch code — the idempotence probe. */
async function existingBatches(conn, companyId) {
  const [rows] = await conn.query(
    `SELECT DISTINCT batch_no
       FROM fab_stock_pieces
      WHERE company_id = ? AND deleted_at IS NULL
        AND batch_no LIKE ?`,
    [companyId, `${BATCH_PREFIX}-%`],
  );
  return new Set(rows.map((r) => r.batch_no));
}

/**
 * The size fields must exist before a single piece is created.
 *
 * Module 01 owns them. If it has not run, `setFields` would reject every
 * dimension, `receiveStock` would log a warning and carry on, and we would
 * rebuild the tenant with 173 unsized pieces all over again. Checked up front
 * so the failure names its own cause instead of arriving as a warning nobody
 * reads.
 */
async function assertSizeFields(conn, companyId) {
  const [rows] = await conn.query(
    `SELECT field_key, applies_at, active
       FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL
        AND field_key IN ('length_mm', 'width_mm')`,
    [companyId],
  );
  const byKey = new Map(rows.map((r) => [r.field_key, r]));
  for (const key of ['length_mm', 'width_mm']) {
    const f = byKey.get(key);
    if (!f || !f.active) {
      throw new Error(
        `Field "${key}" does not exist (or is inactive) for company ${companyId}. `
        + 'Run module 01-fields first — without it every piece would be created sizeless, '
        + 'which is the exact defect this module exists to prevent.',
      );
    }
    if (f.applies_at !== 'stock_piece') {
      throw new Error(
        `Field "${key}" is authored at "${f.applies_at}", not "stock_piece", so a piece `
        + 'cannot hold it and every size would be silently rejected.',
      );
    }
  }
}

export async function seed(ctx) {
  const { companyId, apply, conn, log } = ctx;

  const warehouse = await findWarehouse(conn, companyId);
  if (!warehouse) {
    throw new Error(
      `No raw-material warehouse found for company ${companyId}. Looked for `
      + `${WAREHOUSE_CODES.join(', ')}. Raw material must not be seeded into a machine WIP area, `
      + 'so nothing was created.',
    );
  }
  if (FORBIDDEN_LOCATION.test(String(warehouse.code))) {
    throw new Error(`Refusing to receive raw material into "${warehouse.code}" — that is a machine/WIP area.`);
  }
  log(`Warehouse: ${warehouse.code} (${warehouse.name}), plant ${warehouse.plant_id}`);

  await assertSizeFields(conn, companyId);

  // ── Build the full plan first, so a dry run reports exactly what --apply does.
  const sized = [...PLATE_PROFILE, ...SECTION_PROFILE];
  const sizedNames = sized.map((s) => s.name);
  const catalog = await itemsByName(conn, companyId, sizedNames);

  const missing = sizedNames.filter((n) => !catalog.has(n));
  if (missing.length) log(`NOT IN CATALOG, skipped: ${missing.join(' · ')} (module 02 creates these)`);

  /** @type {Array<{item:object, lot:object, batchNo:string, why:string}>} */
  const plan = [];

  for (const spec of sized) {
    const item = catalog.get(spec.name);
    if (!item) continue;
    for (const lot of spec.lots) {
      plan.push({ item, lot, batchNo: batchCodeFor(item.code, lot.length, lot.width), why: spec.why });
    }
  }

  // Raw materials the profile does not name — stocked on a documented default.
  const extras = await unprofiledRawMaterials(conn, companyId, new Set(sizedNames));
  for (const item of extras) {
    const isPlate = String(item.material_form ?? '').toLowerCase() === 'plate';
    const lot = isPlate
      ? { length: 12000, width: 2400, pieces: 2 }
      : { length: 12000, width: sectionWidthFromName(item.name) ?? 100, pieces: 3 };
    log(`Not in profile: ${item.code} — defaulting to ${lot.pieces} × ${lot.length}×${lot.width}`
      + ` (${isPlate ? 'plate' : 'section'})`);
    plan.push({
      item,
      lot,
      batchNo: batchCodeFor(item.code, lot.length, lot.width),
      why: `default for an unprofiled ${isPlate ? 'plate' : 'section'}`,
    });
  }

  // Consumables and spares — a token quantity, no size. See CONSUMABLE_QTY.
  const tokens = await tokenItems(conn, companyId);
  if (!tokens.length) {
    log('No Consumables / MRO & Spares items found — nothing to give a token quantity to.');
  }
  for (const item of tokens) {
    const lot = { length: null, width: null, pieces: 1, qty: tokenQtyFor(item.unit) };
    plan.push({
      item,
      lot,
      batchNo: batchCodeFor(item.code, null, null),
      why: `${item.category} — token opening quantity, no meaningful size`,
    });
  }

  // ── Idempotence: a lot whose batch already exists is skipped whole.
  const already = await existingBatches(conn, companyId);

  let serial = 0;
  let pieces = 0;
  let qty = 0;
  let ledgerRows = 0;
  let skipped = 0;

  for (const entry of plan) {
    const { item, lot, batchNo } = entry;
    // The heat numbers advance over the WHOLE plan, skipped lots included, so a
    // partial re-run assigns the same heat to the same piece as a full one.
    const firstSerial = serial;
    serial += lot.pieces;

    if (already.has(batchNo)) {
      skipped += 1;
      continue;
    }

    const perPieceQty = lot.qty ?? 1;
    const sizeLabel = lot.length == null ? 'no size (token qty)' : `${lot.length}×${lot.width} mm`;

    if (!apply) {
      pieces += lot.pieces;
      qty += lot.pieces * perPieceQty;
      ledgerRows += lot.pieces;
      log(`would receive ${lot.pieces} × ${item.code} @ ${sizeLabel} — batch ${batchNo}`);
      continue;
    }

    const payload = {
      catalog_item_id: item.id,
      plant_id: warehouse.plant_id,
      stock_location_id: warehouse.id,
      received_date: OPENING_DATE,
      uom: item.unit ?? null,
      unit_cost: unitCostFor(item, lot),
      notes: `Opening stock — ${entry.why}`,
      pieces: Array.from({ length: lot.pieces }, (_, i) => ({
        qty: perPieceQty,
        batch_no: batchNo,
        heat_no: heatNoFor(firstSerial + i + 1),
        // Passed as snake_case, which `receiveStock` accepts directly — the
        // route's camelCase mapping is a transport concern, not a service one.
        length_mm: lot.length,
        width_mm: lot.width,
      })),
    };

    // Joined to the runner's transaction: one rollback undoes the whole rebuild.
    const result = await receiveStock(companyId, payload, conn);

    /**
     * A rejected dimension is a FAILED SEED, not a warning.
     *
     * `receiveStock` deliberately does not throw on one — a real receipt is
     * sound even if the size did not stick, and undoing goods-in over it would
     * be worse. A seed is the opposite case: an unsized piece here is the whole
     * defect being rebuilt away, so we fail and let the runner roll back.
     */
    if (result.dimensionRejections?.length) {
      const detail = JSON.stringify(result.dimensionRejections);
      throw new Error(`Dimensions rejected while receiving ${item.code} (batch ${batchNo}): ${detail}`);
    }

    pieces += result.pieceIds.length;
    qty += result.qtyTotal;
    ledgerRows += result.pieceIds.length;
    log(`received ${result.pieceIds.length} × ${item.code} @ ${sizeLabel} — batch ${batchNo}`);
  }

  if (skipped) log(`${skipped} lot(s) already present — skipped (batch already on hand).`);

  const shortItem = PLATE_PROFILE.find((p) => p.short);
  if (shortItem) log(`Left short on purpose: ${shortItem.name} — ${shortItem.why}`);

  return { pieces, qty, ledgerRows, lotsSkipped: skipped };
}
