/**
 * 07-machine-identity.mjs — a machine is a thing the company owns, so give it
 * a catalog identity and a stock piece. Then make sure nobody can cut a girder
 * out of it.
 *
 * WHY THIS MODULE EXISTS AT ALL. init.sql grew a "Phase 8" backfill that turns
 * every resource TYPE into a catalog item and every RESOURCE into a stock piece
 * (search it for `MACH-`). That backfill only ever fires for rows whose
 * `catalog_item_id` / `stock_piece_id` are still NULL *at the moment init.sql
 * runs*. Modules 04 creates its ten types and eighteen machines long after
 * that, so they were born without an identity and nothing came back for them:
 * `scripts/verify-machine-catalog.mjs 6` reported 28 warnings — ten unlinked
 * types plus eighteen unlinked machines. This is that backfill, re-expressed as
 * a seed module so it runs at the right point in the order and is idempotent.
 *
 * The shapes below are COPIED from that init.sql block rather than reinvented,
 * because three machines on the local tenant were created by it and any
 * disagreement would show up as two conventions for the same thing:
 *
 *   catalog item code   `MACH-<resource type code>`
 *   category            `mach` (Machines & Equipment), created by module 02
 *   piece serial_no     the machine's own `code` — this is the piece's natural key
 *   piece qty           1, always
 *
 * ── WHERE A MACHINE'S ASSET PIECE LIVES: `MACH-ON`, NOT `WIP-M<id>` ─────────
 *
 * Module 04 gives every machine its own `WIP-M<id>` area, and it is tempting to
 * put the machine's own piece there — one area per machine, tidy. It is the
 * wrong answer, and it is wrong in the exact way the per-machine-WIP work was
 * done to fix.
 *
 * `WIP-M<id>` answers "what work is sitting at this machine right now". Its
 * contents are read as work in process — `wipInventoryService` moves a task's
 * piece into it on start and out of it at the next step, and the buffer and WIP
 * views total what is in it as capital tied up on the floor. Put the machine
 * itself in there and every one of those readings is off by one machine
 * forever: the shop appears to hold a CNC table's worth of work in process that
 * no order will ever consume, and "move that machine's WIP" now has the machine
 * in the set it is reasoning about. That is conflating the machine with the
 * work at the machine, which is precisely the confusion the area-move work
 * exists to avoid.
 *
 * `MACH-ON` ("Machines - on site", seeded per plant by init.sql) answers a
 * different question — where the lump of metal physically stands — and it has a
 * partner, `MACH-OFF`, for when it stands somewhere else. `machineLocationService`
 * already owns moving a machine between the two, and `resourceAreaService`
 * deliberately refuses to move any piece that is some resource's
 * `stock_piece_id`, so a piece parked here cannot be dragged around as a side
 * effect of reassigning a machine's WIP area. It stays put, on purpose, and the
 * one endpoint that may move it is the one whose whole subject is where a
 * machine is.
 *
 * A machine with NO PLANT is therefore skipped rather than failed. A stock
 * piece has a NOT NULL `stock_location_id` and a location is scoped to a plant;
 * inventing one would record the machine as standing somewhere it does not.
 * The verifier agrees — it only flags a machine that HAS a plant and no piece.
 *
 * ── THE SAFETY REQUIREMENT, WHICH IS THE POINT OF THE MODULE ────────────────
 *
 * A machine is now an in-stock piece of a bought catalog item with qty > 0,
 * which is exactly the shape `wipInventoryService.consumeStock` FIFO-picks.
 * The only thing standing between "CNC Plate Cutting" and being issued into a
 * girder is `isConsumable`, and `isConsumable` FAILS OPEN — an item with no
 * explicit value is consumable. Creating the pieces without setting the value
 * would make every machine in the shop issuable as material. So the value is
 * set here, in the same module and the same transaction that creates them.
 *
 * WHERE: on the `mach` CATEGORY. One row, inherited by every machine item, and
 * it keeps being right for a machine type somebody adds next year without
 * anybody remembering to classify it. The field ladder makes the category the
 * natural home and `resolveCatalogFields` applies category first, so a specific
 * machine can still be overridden later without fighting this.
 *
 * HOW — AND THIS IS THE TRAP. `setFields` writes `fab_field_values`, the NEW
 * table. `isConsumable` calls `resolveCatalogFields`, which reads
 * `fab_custom_fields`, the LEGACY one. They are mid-migration and they are not
 * the same store. Writing only through `setFields` would leave a value that
 * looks set in every UI and resolves to nothing in the one function that
 * decides whether a machine can be consumed — the failure would be silent and
 * it would fail OPEN. So BOTH are written, and the module then PROVES the
 * result by calling `isConsumable` for every machine catalog item on its own
 * connection and throwing if any says yes. An assertion, not an assumption:
 * the day the reader moves to the new table, this keeps passing; the day
 * somebody deletes the legacy write, this fails loudly instead of quietly
 * re-opening the hole.
 *
 * `consumable` also has to EXIST as a definition. Module 01 creates only the
 * twelve formula-usable fields and `consumable` is not among them, and
 * `setFields` REJECTS a value whose field is unknown — returning the rejection
 * rather than throwing, so a missing definition reads as a seed that worked.
 * It is created here if absent (`data_type='bool'`, `formula_usable=0`), and
 * every rejection `setFields` returns is turned into a thrown error.
 *
 * Contract: seed(ctx) -> { catalogItems, pieces, created, unchanged, skipped }
 * `catalogItems` and `pieces` are TOTALS ENSURED, not rows inserted; `created`
 * is what this run actually wrote, and it is 0 on a second run.
 */

import { generateCode } from '../../apps/fab_erp/services/codegenService.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';
import { isConsumable } from '../../apps/fab_erp/services/itemFieldService.js';

export const NAME = 'Machine identity';

/** The category machine items must be in. The verifier fails anything else. */
const MACH_CATEGORY = 'mach';

/** Where a machine physically stands. See the header for why not `WIP-M<id>`. */
const ON_SITE_CODE = 'MACH-ON';

/** ASCII only — seeded text is at the mercy of whatever charset the client used. */
const ON_SITE_NAME = 'Machines - on site';

/** The field that decides whether stock of an item may be issued as material. */
const CONSUMABLE_KEY = 'consumable';

/**
 * Data types that can hold the string 'no'.
 *
 * A definition already declared `bool`, `enum` or `text` is left exactly as
 * found — repairing somebody else's field is not this module's business. One
 * declared `number` or `date` cannot store the value at all, so it is repaired
 * to `bool` and the repair is logged.
 */
const ACCEPTS_NO = new Set(['bool', 'enum', 'text']);

export async function seed(ctx) {
  const { companyId, apply, conn } = ctx;
  const log = ctx.log ?? ((m) => console.log(m));

  const counts = {
    catalogItems: 0, pieces: 0, created: 0, updated: 0, unchanged: 0, skipped: 0,
  };

  /* ── 0. the category everything hangs off ──────────────────────────────── */

  const [[category]] = await conn.query(
    `SELECT id, name FROM fab_item_categories
      WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, MACH_CATEGORY],
  );
  if (!category) {
    // Loud. Without it there is nowhere to put a machine item, and putting one
    // in some other category is worse than not creating it: the verifier fails
    // it, and the `consumable = no` set below would land on the wrong rows.
    throw new Error(
      `Company ${companyId} has no '${MACH_CATEGORY}' item category. Module 02 creates it `
      + '(CATEGORIES in 02-materials.mjs) — it must run before machine identity.',
    );
  }
  log(`category: ${category.name} (${MACH_CATEGORY}, id ${category.id})`);

  /* ── 1. `consumable = no`, BEFORE any piece exists ─────────────────────── */
  //
  // Ordering is deliberate. The value is set first, so at no point inside this
  // transaction does a machine exist as in-stock material with the gate open.
  // A rollback between the two would otherwise leave the dangerous half.
  const consumableWork = await ensureNotConsumable(conn, companyId, category.id, apply, log);
  counts.created += consumableWork.created;
  counts.updated += consumableWork.updated;

  /* ── 2. a catalog item per resource TYPE ───────────────────────────────── */
  //
  // EVERY type in the company, not just module 04's ten. The verifier walks
  // fab_resource_types wholesale, and a type seeded by some earlier path is
  // exactly as able to be consumed as one of ours.
  const [types] = await conn.query(
    `SELECT id, code, name, catalog_item_id AS catalogItemId
       FROM fab_resource_types
      WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [companyId],
  );

  const itemIdByTypeId = new Map();
  const machineItemIds = new Set();

  for (const t of types) {
    /**
     * `MACH-<code>` is HAND-BUILT, and that is a departure from module 02's
     * "codes are minted, never typed" rule which is worth stating.
     *
     * A minted code is a fresh sequence number every time it is asked for, so
     * it cannot also be the key you look the row up by — and a module that
     * cannot find what it made last time is not idempotent. The machine items
     * need a natural key, `MACH-` is a namespace no minted code can collide
     * with (minted item codes are `<category shortform>-<seq>`), and it is the
     * convention init.sql already established and the local tenant already
     * carries on three rows. Consistency with existing data beats consistency
     * with a rule aimed at a different problem.
     */
    const code = `MACH-${t.code}`;
    const [[found]] = await conn.query(
      `SELECT id, name, category_id AS categoryId, procurement_type AS procurementType, unit
         FROM fab_item_catalog
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, code],
    );

    let itemId = found?.id ?? null;

    if (!found) {
      counts.catalogItems += 1;
      counts.created += 1;
      log(`+ item ${code.padEnd(16)} ${t.name}`);
      if (apply) {
        itemId = await insertMachineItem(conn, companyId, code, t.name, category.id, log);
      }
    } else {
      counts.catalogItems += 1;
      // Only the two things the verifier and the safety rule depend on are
      // managed: the category (it fails a type whose item is filed elsewhere)
      // and nothing else. Name, unit and description are left as found — an
      // operator may well have renamed a machine model.
      if (Number(found.categoryId) !== Number(category.id)) {
        counts.updated += 1;
        log(`~ item ${code}: category ${found.categoryId} -> ${category.id} (${MACH_CATEGORY})`);
        if (apply) {
          await conn.query(
            'UPDATE fab_item_catalog SET category_id = ? WHERE id = ? AND company_id = ?',
            [category.id, found.id, companyId],
          );
        }
      } else {
        counts.unchanged += 1;
      }
    }

    if (itemId) {
      itemIdByTypeId.set(Number(t.id), Number(itemId));
      machineItemIds.add(Number(itemId));
    }

    if (itemId && Number(t.catalogItemId) !== Number(itemId)) {
      counts.updated += 1;
      log(`~ type ${t.code.padEnd(8)} catalog_item_id ${t.catalogItemId ?? 'NULL'} -> ${itemId}`);
      if (apply) {
        await conn.query(
          'UPDATE fab_resource_types SET catalog_item_id = ? WHERE id = ? AND company_id = ?',
          [itemId, t.id, companyId],
        );
      }
    }
  }

  /* ── 3. a stock piece per MACHINE ──────────────────────────────────────── */

  const [machines] = await conn.query(
    `SELECT id, code, name, plant_id AS plantId, resource_type_id AS typeId,
            stock_piece_id AS pieceId, purchase_date AS purchaseDate,
            DATE(created_at) AS createdOn
       FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [companyId],
  );

  /** MACH-ON per plant, found or made once and reused. */
  const onSiteByPlant = new Map();

  for (const m of machines) {
    if (!m.plantId) {
      // NOT a fault. See the header: a piece needs a location, a location needs
      // a plant, and inventing one would put the machine somewhere it is not.
      counts.skipped += 1;
      log(`- ${m.code.padEnd(10)} ${m.name}: no plant, skipped (a piece needs a location)`);
      continue;
    }

    const itemId = itemIdByTypeId.get(Number(m.typeId)) ?? null;
    if (!itemId) {
      if (apply) {
        // A machine pointing at a soft-deleted resource type. Loud, because a
        // piece of no catalog item is a piece nothing can classify — and an
        // unclassifiable piece is one `isConsumable` fails OPEN on.
        throw new Error(
          `Machine ${m.code} has resource type #${m.typeId}, which has no catalog item. `
          + 'Either the type is soft-deleted or step 2 above did not reach it.',
        );
      }
      /**
       * Dry run on a tenant where the item does not exist yet: nothing was
       * inserted, so nothing has an id to link to. The piece WOULD be created,
       * and reporting it as "skipped" would tell a dry run the rebuild has less
       * to do than it has — which is the one thing a dry run is for.
       */
      counts.pieces += 1;
      counts.created += 1;
      log(`+ piece ${m.code.padEnd(10)} ${m.name} -> ${ON_SITE_CODE}`
        + ' (its type\'s catalog item is minted on --apply)');
      continue;
    }

    /**
     * The piece's natural key is (company, serial_no) — the machine's own code.
     * Not the id in `fab_resources.stock_piece_id`, which is what we are trying
     * to set, and not the auto-increment of anything: a half-finished run that
     * created the piece but died before the UPDATE must find its own piece on
     * the next pass rather than make a second one.
     */
    const [[piece]] = await conn.query(
      `SELECT id, qty, status, catalog_item_id AS catalogItemId,
              stock_location_id AS locationId, plant_id AS plantId
         FROM fab_stock_pieces
        WHERE company_id = ? AND serial_no = ? AND deleted_at IS NULL
        ORDER BY id LIMIT 1`,
      [companyId, m.code],
    );

    let pieceId = piece?.id ?? null;
    counts.pieces += 1;

    if (!piece) {
      const location = await onSiteLocation(conn, companyId, m.plantId, onSiteByPlant, apply, log);
      counts.created += 1;
      log(`+ piece ${m.code.padEnd(10)} ${m.name} -> ${ON_SITE_CODE}`);
      if (apply) {
        pieceId = await insertMachinePiece(conn, companyId, m, itemId, location);
      }
    } else {
      const fixes = [];
      // qty 1 EXACTLY. A machine is a serialised thing, not a quantity: "3 of
      // CNC table" is three machines the leveller cannot tell apart, and a
      // partial consume would leave two thirds of a table.
      if (Number(piece.qty) !== 1) fixes.push(['qty', piece.qty, 1]);
      // The verifier requires the piece's item to equal its TYPE's item — a
      // machine re-typed after its piece was made would otherwise be a piece of
      // the wrong model forever.
      if (Number(piece.catalogItemId) !== Number(itemId)) {
        fixes.push(['catalog_item_id', piece.catalogItemId, itemId]);
      }
      // A piece with qty 1 and any other status is not in stock and not
      // schedulable-looking; `machineLocationService` reads in_stock.
      if (piece.status !== 'in_stock') fixes.push(['status', piece.status, 'in_stock']);

      /**
       * LOCATION IS NEVER TOUCHED ON AN EXISTING PIECE. A machine sitting in
       * `MACH-OFF` is a fact somebody recorded — hired out, at a job site, away
       * for repair — and dragging it back to `MACH-ON` because a seed ran would
       * silently rewrite where a machine is. Only a NEW piece gets placed.
       */

      if (fixes.length) {
        counts.updated += 1;
        log(`~ piece ${m.code}: ${fixes.map(([c, from, to]) => `${c} ${from ?? 'NULL'} -> ${to}`).join(', ')}`);
        if (apply) {
          await conn.query(
            `UPDATE fab_stock_pieces SET qty = 1, catalog_item_id = ?, status = 'in_stock'
              WHERE id = ? AND company_id = ?`,
            [itemId, piece.id, companyId],
          );
        }
      } else {
        counts.unchanged += 1;
      }
    }

    if (pieceId && Number(m.pieceId) !== Number(pieceId)) {
      counts.updated += 1;
      log(`~ ${m.code.padEnd(10)} stock_piece_id ${m.pieceId ?? 'NULL'} -> ${pieceId}`);
      if (apply) {
        await conn.query(
          'UPDATE fab_resources SET stock_piece_id = ? WHERE id = ? AND company_id = ?',
          [pieceId, m.id, companyId],
        );
      }
    }
  }

  /* ── 4. PROVE the gate is shut ─────────────────────────────────────────── */
  //
  // Not "we wrote the value" — the actual function the consumption path calls,
  // for every machine item, on this transaction's connection. If this throws,
  // the runner rolls back and no machine ever existed as pickable stock.
  if (apply && machineItemIds.size) {
    const open = [];
    for (const id of machineItemIds) {
      if (await isConsumable(companyId, id, conn)) open.push(id);
    }
    if (open.length) {
      throw new Error(
        `isConsumable still returns true for catalog item(s) ${open.join(', ')} after setting `
        + `${CONSUMABLE_KEY} = no on category ${category.id}. Machines would be issuable as `
        + 'material. isConsumable reads fab_custom_fields via resolveCatalogFields — check '
        + 'that the legacy row was written and that no item-level value overrides it.',
      );
    }
    log(`isConsumable = false for all ${machineItemIds.size} machine catalog item(s)`);
  }

  return counts;
}

/* ─────────────────────────────── helpers ───────────────────────────────── */

/**
 * Insert one machine catalog item, working around the name unique key.
 *
 * `uq_fic2_company_name_active` means a machine type sharing a name with an
 * existing item would abort the whole rebuild on an INSERT. Suffixing is the
 * lesser evil: the code is the identity here, the name is a label, and a
 * seed that dies because somebody happened to stock a spare called
 * "Metalizing" helps nobody.
 */
async function insertMachineItem(conn, companyId, code, name, categoryId, log) {
  const [[clash]] = await conn.query(
    `SELECT id, code FROM fab_item_catalog
      WHERE company_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, name],
  );
  let finalName = name;
  if (clash) {
    finalName = `${name} (machine)`;
    log(`  ! "${name}" is already item ${clash.code}; naming this one "${finalName}"`);
  }
  const [res] = await conn.query(
    `INSERT INTO fab_item_catalog
       (company_id, code, name, category_id, group_id, subgroup_id, procurement_type, unit, description)
     VALUES (?, ?, ?, ?, NULL, NULL, 'buy', 'nos', ?)`,
    [companyId, code, finalName, categoryId,
      'Machine / equipment model. Owned, not consumed — see the mach category consumable flag.'],
  );
  return res.insertId;
}

/**
 * The machine's asset piece.
 *
 * `serial_no` carries the machine's code, because that is the key the next run
 * finds it by and the key init.sql's own backfill used. `code` is minted from
 * the company's `stock_piece` codegen rule so a machine piece reads like every
 * other piece in the yard and the shared sequence is advanced rather than
 * stepped over.
 */
async function insertMachinePiece(conn, companyId, machine, catalogItemId, location) {
  const code = await generateCode(companyId, 'stock_piece', {}, conn);
  const received = machine.purchaseDate ?? machine.createdOn ?? null;
  const [res] = await conn.query(
    `INSERT INTO fab_stock_pieces
       (company_id, catalog_item_id, plant_id, stock_location_id, code, qty, uom, status,
        serial_no, received_date, notes)
     VALUES (?, ?, ?, ?, ?, 1, 'nos', 'in_stock', ?, ?, ?)`,
    [companyId, catalogItemId, machine.plantId, location.id, code, machine.code, received,
      `Machine ${machine.name} (resource #${machine.id})`],
  );
  return res.insertId;
}

/** `MACH-ON` for one plant, found by code or created to init.sql's shape. */
async function onSiteLocation(conn, companyId, plantId, cache, apply, log) {
  if (cache.has(plantId)) return cache.get(plantId);

  const [[found]] = await conn.query(
    `SELECT id, code, name FROM fab_stock_locations
      WHERE company_id = ? AND plant_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    [companyId, plantId, ON_SITE_CODE],
  );
  if (found) { cache.set(plantId, found); return found; }

  // init.sql seeds one per plant and `wipe-company-fab-data.mjs` deliberately
  // keeps it, so this is a plant created after the fact rather than the normal
  // path. Created rather than thrown on: the alternative is a rebuild that
  // stops because a location it knows exactly how to make is missing.
  log(`+ location ${ON_SITE_CODE} for plant ${plantId} (${ON_SITE_NAME})`);
  let row = { id: null, code: ON_SITE_CODE, name: ON_SITE_NAME };
  if (apply) {
    const [res] = await conn.query(
      `INSERT INTO fab_stock_locations (company_id, plant_id, name, code, description)
       VALUES (?, ?, ?, ?, ?)`,
      [companyId, plantId, ON_SITE_NAME, ON_SITE_CODE,
        'Where machines physically stand at this plant. Auto-provisioned.'],
    );
    row = { id: res.insertId, code: ON_SITE_CODE, name: ON_SITE_NAME };
  }
  cache.set(plantId, row);
  return row;
}

/**
 * `consumable = no` on the machines category, in BOTH field stores.
 *
 * The two writes are not redundancy, they are two different tables that two
 * different readers use, mid-migration:
 *
 *   fab_field_values   what `setFields` / `resolveFields` (fieldService) use —
 *                      the registry screen, the parameters grid, everything new
 *   fab_custom_fields  what `resolveCatalogFields` reads, and therefore what
 *                      `isConsumable` — the function that actually stops a
 *                      machine being issued as material — resolves from
 *
 * Write only the first and the value is visible everywhere except the one place
 * it matters. Write only the second and it disappears the day the reader moves.
 *
 * @returns {{created:number, updated:number}}
 */
async function ensureNotConsumable(conn, companyId, categoryId, apply, log) {
  const out = { created: 0, updated: 0 };

  /* -- the definition, without which setFields silently rejects the value -- */
  const [[def]] = await conn.query(
    `SELECT id, data_type AS dataType, applies_at AS appliesAt, active, deleted_at
       FROM fab_fields WHERE company_id = ? AND field_key = ? LIMIT 1`,
    [companyId, CONSUMABLE_KEY],
  );

  if (!def) {
    out.created += 1;
    log(`+ field ${CONSUMABLE_KEY} (bool, not formula-usable)`);
    if (apply) {
      await conn.query(
        `INSERT INTO fab_fields
           (company_id, field_key, label, data_type, dimension, default_unit, applies_at,
            formula_usable, is_standard, sort_order, active)
         VALUES (?, ?, ?, 'bool', NULL, NULL, 'catalog_item', 0, 1, 900, 1)`,
        [companyId, CONSUMABLE_KEY, 'Can be consumed into a product'],
      );
    }
  } else {
    // `uq_ff_company_key` does not exclude deleted rows, and `fieldRegistry`
    // only sees active ones — a soft-deleted or inactive definition means
    // setFields answers "no such field" for a row that is sitting right there.
    const fixes = [];
    if (def.deleted_at != null) fixes.push('undeleted');
    if (!def.active) fixes.push('reactivated');
    // Left alone when it can already hold 'no'. Repaired only when it cannot.
    const retype = !ACCEPTS_NO.has(String(def.dataType));
    if (retype) fixes.push(`data_type: ${def.dataType} -> bool`);
    if (fixes.length) {
      out.updated += 1;
      log(`~ field ${CONSUMABLE_KEY}: ${fixes.join(', ')}`);
      if (apply) {
        await conn.query(
          `UPDATE fab_fields
              SET active = 1, deleted_at = NULL${retype ? ", data_type = 'bool'" : ''}
            WHERE id = ? AND company_id = ?`,
          [def.id, companyId],
        );
      }
    }
  }

  /* -- the value, in the new store -------------------------------------- */
  //
  // 'no' is the spelling, not false: setFields' bool branch takes
  // yes/true/1/y and no/false/0/n and REFUSES anything else, and 'no' is what
  // the legacy rows below already say. Rejections come back in the result
  // rather than as an exception, so they are checked — an unchecked rejection
  // here is a machine that stays consumable and a seed that reports success.
  //
  // Read before writing, because `setFields` is an ON DUPLICATE KEY upsert and
  // reports `written: 1` whether or not anything changed. Calling it
  // unconditionally would make every re-run claim work it did not do, and "the
  // second run wrote nothing" is the only way idempotence is ever checked.
  const [[stored]] = await conn.query(
    `SELECT v.value_num AS num FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'category' AND v.scope_id = ?
        AND f.field_key = ? AND v.deleted_at IS NULL LIMIT 1`,
    [companyId, categoryId, CONSUMABLE_KEY],
  );
  if (Number(stored?.num) !== 0) {
    out.updated += stored ? 1 : 0;
    out.created += stored ? 0 : 1;
    log(`${stored ? '~' : '+'} ${CONSUMABLE_KEY}=no on category ${categoryId} (fab_field_values)`);
    if (apply) {
      const res = await setFields(companyId, 'category', categoryId, { [CONSUMABLE_KEY]: 'no' }, conn);
      if (res.rejected?.length) {
        throw new Error(
          `setFields rejected ${CONSUMABLE_KEY} on the ${MACH_CATEGORY} category: `
          + res.rejected.map((r) => `${r.fieldKey} — ${r.why}`).join('; '),
        );
      }
    }
  }

  /* -- the value, in the legacy store isConsumable actually reads --------- */
  //
  // `fab_custom_fields` has NO unique key on (company, level, level_id,
  // field_key), so this cannot be an upsert — a blind INSERT would add a second
  // row on every run and `resolveCatalogFields` would pick between them by
  // whichever the query returned last.
  const [existing] = await conn.query(
    `SELECT id, field_value AS value FROM fab_custom_fields
      WHERE company_id = ? AND level = 'category' AND level_id = ? AND field_key = ?
        AND deleted_at IS NULL
      ORDER BY id`,
    [companyId, categoryId, CONSUMABLE_KEY],
  );

  const wrong = existing.filter((r) => String(r.value).trim().toLowerCase() !== 'no');
  if (!existing.length) {
    out.created += 1;
    log(`+ legacy ${CONSUMABLE_KEY}=no on category ${categoryId} (fab_custom_fields)`);
    if (apply) {
      await conn.query(
        `INSERT INTO fab_custom_fields
           (company_id, level, level_id, field_key, field_type, field_value, sort_order)
         VALUES (?, 'category', ?, ?, 'text', 'no', 0)`,
        [companyId, categoryId, CONSUMABLE_KEY],
      );
    }
  } else if (wrong.length) {
    out.updated += 1;
    log(`~ legacy ${CONSUMABLE_KEY} on category ${categoryId}: ${wrong.map((r) => r.value).join('/')} -> no`);
    if (apply) {
      await conn.query(
        `UPDATE fab_custom_fields SET field_value = 'no', field_type = 'text'
          WHERE id IN (?) AND company_id = ?`,
        [wrong.map((r) => r.id), companyId],
      );
    }
  }

  /**
   * An ITEM-level 'yes' would beat the category and re-open the gate for that
   * one machine — `resolveCatalogFields` applies item last. Any such row on a
   * machine item is corrected, because the category rule is the decision and a
   * stray override is how it gets quietly undone.
   */
  const [overrides] = await conn.query(
    `SELECT cf.id, cf.level_id AS itemId, cf.field_value AS value, i.code
       FROM fab_custom_fields cf
       JOIN fab_item_catalog i ON i.id = cf.level_id AND i.company_id = cf.company_id
        AND i.deleted_at IS NULL
      WHERE cf.company_id = ? AND cf.level = 'item' AND cf.field_key = ?
        AND cf.deleted_at IS NULL AND i.category_id = ?`,
    [companyId, CONSUMABLE_KEY, categoryId],
  );
  const badOverrides = overrides.filter((r) => String(r.value).trim().toLowerCase() !== 'no');
  if (badOverrides.length) {
    out.updated += 1;
    log(`~ ${badOverrides.length} item-level ${CONSUMABLE_KEY} override(s) on machine items -> no`
      + ` (${badOverrides.map((r) => r.code).join(', ')})`);
    if (apply) {
      await conn.query(
        `UPDATE fab_custom_fields SET field_value = 'no' WHERE id IN (?) AND company_id = ?`,
        [badOverrides.map((r) => r.id), companyId],
      );
    }
  }

  return out;
}
