/**
 * blankService.js — the rectangle that gets cut, which until now had no name.
 *
 * ── THE PROBLEM IT SOLVES ────────────────────────────────────────────────────
 *
 * Nesting has always linked a plate straight to a finished part. So an order
 * needing 960 identical stiffeners holds 960 pointers at plate, and the fact
 * that they are ONE rectangle cut 960 times exists nowhere in the data — it
 * lives for a moment inside the packer and is thrown away.
 *
 * That costs three things. The shop is told to cut 960 different things when it
 * is setting up once. A part that is 170 x 2995 under a Segment and the same
 * 170 x 2995 under a Diaphragm is bought for, cut and tracked twice. And there
 * is nothing to raise a cutting order against, because there is no row that says
 * "this rectangle, this many".
 *
 * A BLANK is that row: material, grade and a rectangle, with a count.
 *
 * ── WHAT MAKES TWO PARTS THE SAME BLANK ──────────────────────────────────────
 *
 * Material, grade, thickness, and the two in-plane sizes. Nothing else — not the
 * part's name, not where it sits in the structure, not what happens to it
 * afterwards. A drilled stiffener and a plain one of the same size are ONE
 * blank; the drilling is a later operation on an identical piece of steel.
 *
 * THE TWO IN-PLANE SIZES ARE SORTED. 170 x 2995 and 2995 x 170 are the same
 * rectangle — the cutter turns the part, and the packer already tries both
 * orientations. Keeping them apart would buy two plates for one shape. The
 * exception nobody has asked for yet is rolling direction; if that ever matters
 * it belongs as a field on the part, not as an accident of which number somebody
 * typed in which box.
 *
 * ── SCOPED TO THE ORDER, ON PURPOSE ──────────────────────────────────────────
 *
 * The blanks live under `Raw Materials > Blanks > <order number>`. A shared
 * namespace was tried and rejected: every order would drop its rectangles into
 * one pile, and a year of bridges makes a catalogue nobody can read, in which
 * the interesting question — "what is THIS job cutting" — cannot be asked.
 *
 * Per order, the group grows with live work and can be retired with it.
 *
 * ── CUTTING IS ITS OWN BATCH OF ORDINARY WORK ────────────────────────────────
 *
 * A blank row goes on the SALES ORDER beside everything else, carrying the
 * cutting flow. Its TASKS are claimed by a SECOND production order —
 * `mo_purpose='cutting'` — not by the fabrication one.
 *
 * Two orders, because they wait on different things. Cutting waits on PLATE
 * ARRIVING; fabrication waits on shop capacity. Folded together, cutting cannot
 * be released the day the steel lands, which is the day you want it released,
 * and "cutting is 80% done" stops being visible at all because it is twenty
 * tasks buried in five hundred.
 *
 * It is NOT a separate `order_type`. Cutting is not a different kind of
 * manufacturing, it is a different batch of it — so the type stays
 * 'manufacturing' and `mo_purpose` says which batch.
 *
 * The cost of putting them on the sales order is that a blank row LOOKS like a
 * made leaf — it is childless apart from the plate beneath it — so the function
 * that computes blanks would happily make blanks out of blanks. That is what
 * `NOT_A_BLANK` below is for, and it is why the exclusion is written once and
 * shared rather than repeated at each call site.
 */

import { pool, getLiveConnection } from '../../../db.js';
import { resolveFields, setFieldsBulk } from './fieldService.js';
import { resolveItemFields } from './itemFieldService.js';
import { DEFAULT_DENSITY } from './fieldDeriveService.js';
import { weightFactorsForParts, axisConflicts } from './materialMatchService.js';
import { recomputeOrderWeights } from './itemWeightService.js';
import { NOT_A_BLANK, IS_A_BLANK, isMadeChildlessLeaf, rolledQty as rolledQtyOf } from './blankPredicate.js';
import { lineQtyMap } from './orderLineQty.js';
import { deriveCodes, generateCode } from './codegenService.js';
import { verify as verifyPacking } from './nestingPacker.js';
import { kerfFor } from './kerfService.js';

export { NOT_A_BLANK } from './blankPredicate.js';
import { materializeOrderTasks } from './taskGatingService.js';
import { logger } from '../../../core/utils/logger.js';

/** The flow a blank is cut by, unless the plan names another. */
export const CUTTING_FLOW_CODE = 'C0001';

/** Where blanks are filed. The group is expected to exist; the subgroup is per order. */
const BLANK_CATEGORY = 'Raw Materials';
const BLANK_GROUP = 'Blanks';

const codeBit = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "SO-20260910-0066" -> "202609100066": the letters say "sales order" on a code that already begins BLK. */
const orderRef = (orderNumber) => codeBit(String(orderNumber).replace(/^[A-Za-z]+-/, ''));

/**
 * Codes for blanks, from the company's 'blank' rule in the code generator.
 *
 * DERIVED, so the same rectangle on the same order is always the same code —
 * which is what lets a saved plan, a downloaded sheet and the catalog all find
 * each other by it.
 */
export async function blankCodes(companyId, orderNumber, shapes) {
  return deriveCodes(companyId, 'blank', shapes.map((b) => ({
    attributes: {
      orderRef: orderRef(orderNumber),
      material: codeBit(b.material), grade: codeBit(b.grade),
      thickness: b.thickness, width: b.width, length: b.length,
    },
  })));
}

export function blankName(orderNumber, { material, grade, thickness, width, length }) {
  const steel = [material, grade].filter(Boolean).join(' ');
  return `${steel || 'Blank'} ${thickness} x ${width} x ${length} — ${orderNumber}`;
}

/** The identity of a blank, as a string, for grouping. */
const blankKey = (b) => [b.material ?? '?', b.grade ?? '?', b.thickness, b.width, b.length].join('|');

/**
 * Every rectangle this order has to cut, and how many of each.
 *
 * @returns {Promise<{orderNumber:string, blanks:object[], skipped:object[]}>}
 */
export async function orderBlanks(companyId, orderId, existingConn = null) {
  const exec = existingConn ?? pool;

  const [[order]] = await exec.query(
    `SELECT id, order_number AS orderNumber FROM fab_orders
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [orderId, companyId],
  );
  if (!order) { const e = new Error('That order does not exist.'); e.status = 404; throw e; }

  /*
   * MADE LEAVES ONLY, and "leaf" has to ignore the row's own material links —
   * a part that has been nested has a material child, and counting that as a
   * child would make every nested part an assembly and drop it from the list.
   */
  const [parts] = await exec.query(
    `SELECT p.id, p.name, p.qty, p.parent_item_id AS parentItemId, p.catalog_item_id AS catalogItemId
       FROM fab_items p
      WHERE p.company_id = ? AND p.order_id = ? AND p.deleted_at IS NULL
        AND NOT p.node_kind = 'material'
        AND ${isMadeChildlessLeaf('p')}
      ORDER BY p.id`,
    [companyId, orderId],
  );
  if (!parts.length) return { orderNumber: order.orderNumber, blanks: [], skipped: [] };

  /*
   * HOW MANY THE ORDER NEEDS, not what the row says. A row is a design: "Top
   * Flange x1" under "Segment x3" under "Line x4" is twelve flanges. Reading
   * the row's own number understated one order by 96%.
   */
  const [allRows] = await exec.query(
    `SELECT id, parent_item_id AS parentItemId, qty, order_line_id AS orderLineId FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND NOT node_kind = 'material'`,
    [companyId, orderId],
  );
  const nodeById = new Map(allRows.map((r) => [Number(r.id), r]));
  /**
   * A blank plan for a line of qty 3 lays out three times the pieces (User
   * Clarifications 5) — the honest answer, and what makes the plate count
   * right once nesting collapses these onto shared sheets. `lineQty` is
   * looked up once per order, not once per part.
   */
  const lineQty = await lineQtyMap(exec, companyId, orderId);
  const rolledQty = (partId) => rolledQtyOf(nodeById, partId, lineQty);

  const ids = parts.map((p) => Number(p.id));
  const nums = await resolveItemFields(companyId, ids, { conn: existingConn ?? undefined });
  // Material and grade are TEXT, which the numbers-only resolver cannot carry.
  const text = await resolveFields(
    companyId, ids.map((id) => ({ scope: 'order_item', scopeId: id })),
    { conn: existingConn ?? undefined },
  );

  /*
   * DENSITY, resolved the way the weight roll-up resolves it for an un-nested
   * part: from the catalogue, keyed on the part's material / grade / thickness
   * (`weightFactorsForParts`). The blank has to CARRY this number. Once a part
   * is nested its material link points at the blank, and `itemWeightService`
   * reads density off the linked catalogue row and nothing else — so a blank
   * without one turns every part cut from it to "weight unknown", on an order
   * that weighed correctly the day before. The KEPL order lost 669 t this way.
   */
  const factors = await weightFactorsForParts(companyId, ids, { conn: existingConn ?? undefined });

  const byKey = new Map();
  const skipped = [];

  for (const p of parts) {
    const n = nums.get(Number(p.id)) ?? {};
    const t = text.get(`order_item:${p.id}`) ?? {};
    const thickness = Number(n.thickness_mm);
    const a = Number(n.width_mm);
    const b = Number(n.length_mm);

    if (!Number.isFinite(thickness) || !Number.isFinite(a) || !Number.isFinite(b)) {
      skipped.push({ itemId: Number(p.id), name: p.name, reason: 'no size on it yet' });
      continue;
    }
    // Sorted: a rectangle has no opinion about which side you call the length.
    const width = Math.min(a, b);
    const length = Math.max(a, b);

    const material = t.material?.value ?? null;
    const grade = t.grade?.value ?? null;
    if (!material || !grade) {
      skipped.push({
        itemId: Number(p.id), name: p.name,
        reason: !material && !grade ? 'no material or grade' : (!material ? 'no material' : 'no grade'),
      });
      continue;
    }

    const fromSpec = factors.get(Number(p.id))?.density;
    const density = Number.isFinite(Number(fromSpec)) && Number(fromSpec) > 0 ? Number(fromSpec)
      : (Number.isFinite(Number(n.density_kg_m3)) && Number(n.density_kg_m3) > 0 ? Number(n.density_kg_m3)
        : DEFAULT_DENSITY);
    const shape = { material: String(material), grade: String(grade), thickness, width, length };
    const key = blankKey(shape);
    const qty = rolledQty(p.id);

    const hit = byKey.get(key) ?? {
      ...shape,
      key,
      qty: 0,
      density,
      unitWeightKg: thickness * width * length * density / 1e9,
      parts: [],
      catalogItemId: null,
    };
    hit.qty += qty;
    hit.parts.push({ itemId: Number(p.id), name: p.name, qty });
    byKey.set(key, hit);
  }

  // Heaviest first — the order somebody reads it in, because that is the order
  // in which a wrong plate costs money.
  const blanks = [...byKey.values()].sort((x, y) => (y.qty * y.unitWeightKg) - (x.qty * x.unitWeightKg));
  const codes = await blankCodes(companyId, order.orderNumber, blanks);
  // `ref` is the SHORT handle the cutting-plan sheet uses: the code with the
  // order's own prefix taken off (BLK-202609150014-MS-E350BO-16X1800X10000 →
  // MS-E350BO-16X1800X10000). Every blank on one order shares that prefix,
  // so nothing is lost inside the order, and it still reads as what it is —
  // unlike a running number, which changes when the BOM does.
  const prefix = `BLK-${orderRef(order.orderNumber)}-`;
  blanks.forEach((b, i) => {
    b.code = codes[i];
    b.ref = b.code.startsWith(prefix) ? b.code.slice(prefix.length) : b.code;
  });
  for (const b of blanks) {
    b.name = blankName(order.orderNumber, b);
    b.totalWeightKg = b.qty * b.unitWeightKg;
    /*
     * The distinct names, for reading. `parts` holds one entry per structure
     * row, and a rectangle used under both spans and five segments repeats the
     * same name eight times — true, and useless on screen.
     */
    b.partNames = [...new Set(b.parts.map((x) => x.name))];
  }
  return { orderNumber: order.orderNumber, blanks, skipped };
}

/**
 * Give the blanks catalogue rows, so they can be pointed at, ordered and cut.
 *
 * IDEMPOTENT BY CODE. The code is derived from the identity, so running this
 * twice finds what it wrote the first time and updates it rather than making a
 * second copy — which matters because re-nesting an order is normal, and a
 * catalogue that gains twenty-four rows every time somebody changes their mind
 * is a catalogue nobody trusts.
 */
export async function materialiseBlanks(companyId, orderId, existingConn = null) {
  const conn = existingConn ?? await pool.getConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();

    const { orderNumber, blanks, skipped } = await orderBlanks(companyId, orderId, conn);
    if (!blanks.length) {
      if (owned) await conn.commit();
      return { orderNumber, created: 0, updated: 0, blanks, skipped };
    }

    const [[group]] = await conn.query(
      `SELECT g.id, g.category_id AS categoryId FROM fab_item_groups g
         JOIN fab_item_categories c ON c.id = g.category_id
        WHERE g.company_id = ? AND g.deleted_at IS NULL
          AND g.name = ? AND c.name = ? LIMIT 1`,
      [companyId, BLANK_GROUP, BLANK_CATEGORY],
    );
    if (!group) {
      const e = new Error(`No "${BLANK_CATEGORY} > ${BLANK_GROUP}" group to file blanks under.`);
      e.status = 500; throw e;
    }

    // One subgroup per order, named by the order. Created on demand, revived if
    // a previous run of this order retired it.
    let [[sub]] = await conn.query(
      `SELECT id FROM fab_item_subgroups
        WHERE company_id = ? AND group_id = ? AND name = ? LIMIT 1`,
      [companyId, group.id, orderNumber],
    );
    if (!sub) {
      const [r] = await conn.query(
        `INSERT INTO fab_item_subgroups (company_id, group_id, name, code, description, created_at)
         VALUES (?,?,?,?,?,UTC_TIMESTAMP())`,
        [companyId, group.id, orderNumber, `BLK-${orderRef(orderNumber)}`,
          `Blanks cut for ${orderNumber}`],
      );
      sub = { id: r.insertId };
    } else {
      await conn.query(`UPDATE fab_item_subgroups SET deleted_at = NULL WHERE id = ?`, [sub.id]);
    }

    let created = 0;
    let updated = 0;
    // Field writes are batched across every blank into one setFieldsBulk call
    // below, instead of one raw INSERT per key per blank.
    const fieldRows = [];

    for (const b of blanks) {
      const [[existing]] = await conn.query(
        `SELECT id FROM fab_item_catalog WHERE company_id = ? AND code = ? LIMIT 1`,
        [companyId, b.code],
      );
      if (existing) {
        await conn.query(
          `UPDATE fab_item_catalog
              SET name = ?, unit = 'nos', category_id = ?, group_id = ?, subgroup_id = ?,
                  procurement_type = 'make', thickness_mm = ?, density_kg_m3 = ?,
                  material_form = 'blank', deleted_at = NULL
            WHERE id = ? AND company_id = ?`,
          [b.name, group.categoryId, group.id, sub.id, b.thickness, b.density, existing.id, companyId],
        );
        b.catalogItemId = Number(existing.id);
        updated += 1;
      } else {
        const [r] = await conn.query(
      /*
       * THE DESCRIPTION DOES NOT NAME THE PARTS.
       *
       * It used to list them, which read as if the blank belonged to those
       * parts — and a blank does not: it is a SIZE, and this one serves eight
       * part rows. The list also repeated itself (the same name once per row)
       * and went stale the moment somebody edited the structure, while sitting
       * in a catalogue record that outlives the edit.
       *
       * Which parts draw on a blank is a live question, answered by looking at
       * what points at it. It is not an attribute of the blank.
       */
          `INSERT INTO fab_item_catalog
             (company_id, name, code, unit, category_id, group_id, subgroup_id,
              procurement_type, thickness_mm, density_kg_m3, material_form, description, created_at)
           VALUES (?,?,?,'nos',?,?,?,'make',?,?,'blank',?,UTC_TIMESTAMP())`,
          [companyId, b.name, b.code, group.categoryId, group.id, sub.id, b.thickness, b.density,
            `${b.material} ${b.grade} plate, ${b.thickness} x ${b.width} x ${b.length}, cut for ${orderNumber}.`],
        );
        b.catalogItemId = r.insertId;
        created += 1;
      }

      /*
       * The rectangle as FIELDS, not just as a name. Nesting filters on
       * thickness and grade, and reading them out of a name is how "Top Flnage"
       * becomes a different material.
       *
       * ON DUPLICATE KEY UPDATE always: `uq_ffv_target` counts soft-deleted
       * rows, so delete-then-insert collides with the row just removed.
       *
       * `density_kg_m3` is written as a value AND as the column above, the way
       * fieldProjection.js keeps the two: the roll-up reads the column, the
       * material matcher reads the value. Leave either out and a nested part
       * weighs nothing.
       */
      const vals = [
        ['thickness_mm', b.thickness], ['width_mm', b.width], ['length_mm', b.length],
        ['unit_weight_kg', b.unitWeightKg], ['density_kg_m3', b.density],
        ['material', b.material], ['grade', b.grade],
      ];
      for (const [key, value] of vals) {
        fieldRows.push({ scopeId: b.catalogItemId, key, value });
      }
    }
    if (fieldRows.length) await setFieldsBulk(companyId, 'catalog_item', fieldRows, conn);

    /*
     * BLANKS THAT ARE NO LONGER CALLED FOR are retired, not left lying about.
     * Editing the structure changes which rectangles the order needs, and a
     * blank nothing points at would still be offered to nesting and still be
     * bought for.
     */
    const live = blanks.map((b) => b.catalogItemId).filter(Boolean);
    const [stale] = await conn.query(
      `SELECT id, code FROM fab_item_catalog
        WHERE company_id = ? AND subgroup_id = ? AND deleted_at IS NULL
          ${live.length ? 'AND id NOT IN (?)' : ''}`,
      live.length ? [companyId, sub.id, live] : [companyId, sub.id],
    );
    if (stale.length) {
      await conn.query(
        `UPDATE fab_item_catalog SET deleted_at = UTC_TIMESTAMP() WHERE company_id = ? AND id IN (?)`,
        [companyId, stale.map((s) => s.id)],
      );
    }

    if (owned) await conn.commit();
    return {
      orderNumber, created, updated, retired: stale.length,
      subgroupId: Number(sub.id), blanks, skipped,
    };
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * The CUTTING production order for a sales order, made if it is not there yet.
 *
 * `order_type='manufacturing'` like the fabrication one, told apart by
 * `mo_purpose='cutting'`. It claims exactly the tasks sitting on blank rows;
 * `productionOrderService` claims everything else and now explicitly declines
 * these, so the two documents partition the work rather than overlapping.
 */
export async function ensureCuttingOrder(companyId, salesOrderId, conn) {
  const [[sales]] = await conn.query(
    `SELECT id, order_number AS orderNumber, plant_id AS plantId, required_date AS requiredDate
       FROM fab_orders
      WHERE id = ? AND company_id = ? AND order_type = 'sales' AND deleted_at IS NULL LIMIT 1`,
    [salesOrderId, companyId],
  );
  if (!sales) { const e = new Error('That sales order does not exist.'); e.status = 404; throw e; }

  let [[mo]] = await conn.query(
    `SELECT id, order_number AS orderNumber, status FROM fab_orders
      WHERE company_id = ? AND source_order_id = ? AND order_type = 'manufacturing'
        AND mo_purpose = 'cutting' AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [companyId, salesOrderId],
  );
  let created = false;

  if (!mo) {
    // Numbered by the code generator, from the same counter as every other
    // production order. It used to count rows and add one, which hands two
    // people pressing Accept at once the same number.
    const orderNumber = await generateCode(companyId, 'manufacturing_order', {}, conn);
    const [ins] = await conn.query(
      `INSERT INTO fab_orders
         (company_id, order_number, order_type, mo_purpose, status, source_order_id,
          plant_id, required_date, notes, created_at)
       VALUES (?,?,'manufacturing','cutting','draft',?,?,?,?,UTC_TIMESTAMP())`,
      [companyId, orderNumber, salesOrderId, sales.plantId ?? null, sales.requiredDate ?? null,
        `Plate to blanks for ${sales.orderNumber}`],
    );
    mo = { id: ins.insertId, orderNumber, status: 'draft' };
    created = true;
  }

  /*
   * Claim the cutting work. Only tasks whose item IS a blank — the mirror of the
   * exclusion the fabrication order applies, so between them every make task is
   * claimed exactly once.
   */
  const [claim] = await conn.query(
    `UPDATE fab_project_tasks t
       JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
        SET t.production_order_id = ?
      WHERE t.company_id = ? AND t.order_id = ? AND t.deleted_at IS NULL
        AND ${IS_A_BLANK('i')}
        AND (t.production_order_id IS NULL OR t.production_order_id <> ?)`,
    [mo.id, companyId, salesOrderId, mo.id],
  );

  return { ...mo, sales, created, tasksClaimed: claim?.affectedRows ?? 0 };
}

/**
 * The next nest number for an order, per §13 "A nest is one plate, and
 * `nest_no` is the only thing that says so" — sheets are numbered PER ORDER,
 * not per blank/catalog item, so two different plates on the same order never
 * share a label. Reads the high-water mark off whatever is still live; callers
 * that are about to replace the whole order's nests (as `acceptNestingPlan`
 * does) call this AFTER wiping the old rows, so it correctly restarts at 1.
 */
export async function nextNestNo(conn, companyId, orderId) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(nest_no, 3) AS UNSIGNED)), 0) AS maxNo
       FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND nest_no REGEXP '^N-[0-9]+$'`,
    [companyId, orderId],
  );
  return Number(row?.maxNo) || 0;
}

/**
 * The real plate behind a nest entry from a client-supplied plan — a catalogue
 * size (`plateCatalogItemId` > 0) or a specific offcut (< 0, the negative of
 * its `fab_stock_pieces.id`, `plateSourceService.offcutSpecs`'s own encoding).
 * Batched (two queries total, not one per nest) so accepting a 130-plate plan
 * does not run 130 round trips to learn what it already named.
 */
async function resolvePlatesForNests(conn, companyId, nests) {
  const rawIds = nests.map((n) => Number(n.plateCatalogItemId)).filter(Number.isFinite);
  const catalogIds = [...new Set(rawIds.filter((id) => id > 0))];
  const dropIds = [...new Set(rawIds.filter((id) => id < 0).map((id) => -id))];

  const byId = new Map();
  if (catalogIds.length) {
    const [rows] = await conn.query(
      `SELECT ic.id, ic.code, ic.name, ic.thickness_mm AS thickness
         FROM fab_item_catalog ic WHERE ic.company_id = ? AND ic.id IN (?) AND ic.deleted_at IS NULL`,
      [companyId, catalogIds],
    );
    const resolved = await resolveFields(
      companyId, rows.map((r) => ({ scope: 'catalog_item', scopeId: r.id })), { conn },
    );
    for (const r of rows) {
      const f = resolved.get(`catalog_item:${r.id}`) ?? {};
      const length = Number(f.length_mm?.value);
      const width = Number(f.width_mm?.value);
      byId.set(Number(r.id), {
        catalogItemId: Number(r.id), code: r.code, name: r.name,
        thickness: r.thickness != null ? Number(r.thickness) : null,
        length: Number.isFinite(length) ? length : null,
        width: Number.isFinite(width) ? width : null,
        grade: f.grade?.value ?? null, material: f.material?.value ?? null,
        isDrop: false, pieceId: null,
      });
    }
  }

  const byPiece = new Map();
  if (dropIds.length) {
    const [rows] = await conn.query(
      `SELECT p.id AS pieceId, p.catalog_item_id AS catalogItemId, p.code,
              p.length_mm AS length, p.width_mm AS width,
              ic.name AS name, ic.thickness_mm AS thickness
         FROM fab_stock_pieces p JOIN fab_item_catalog ic ON ic.id = p.catalog_item_id AND ic.deleted_at IS NULL
        WHERE p.company_id = ? AND p.id IN (?) AND p.deleted_at IS NULL`,
      [companyId, dropIds],
    );
    for (const r of rows) {
      byPiece.set(Number(r.pieceId), {
        catalogItemId: Number(r.catalogItemId), code: r.code, name: r.name,
        thickness: r.thickness != null ? Number(r.thickness) : null,
        length: Number(r.length) || null, width: Number(r.width) || null,
        // Neither is on the piece itself — an offcut carries no grade/material
        // of its own, only its parent catalogue item's. Left unknown rather
        // than guessed; axisConflicts treats an unknown side as no conflict.
        grade: null, material: null, isDrop: true, pieceId: Number(r.pieceId),
      });
    }
  }

  return (n) => {
    const raw = Number(n.plateCatalogItemId);
    if (!Number.isFinite(raw)) return null;
    return raw < 0 ? (byPiece.get(-raw) ?? null) : (byId.get(raw) ?? null);
  };
}

/**
 * acceptNestingPlan — make the blanks real, and make cutting them ordinary work.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────
 *
 *   1. a catalog item per blank                       (materialiseBlanks)
 *   2. a row per blank ON THE SALES ORDER, carrying the cutting flow
 *   3. the plate under each blank row                 the RM -> blank mapping
 *   4. every part's material link repointed from plate to blank
 *   5. tasks for the new rows, claimed by a CUTTING production order of their own
 *
 * ── WHY THE ROWS GO ON THE SALES ORDER ───────────────────────────────────────
 *
 * Because cutting is not a different kind of manufacturing. An earlier version
 * raised a separate `order_type='cutting'` document, which made every job two
 * things to release, chase and close instead of one, and put the blanks
 * somewhere the rest of the system had to be taught about.
 *
 * On the sales order they are ordinary rows: `materializeOrderTasks` builds
 * their tasks with no special case and the Plan Board shows cutting beside
 * welding. What had to be taught is `NOT_A_BLANK` — so the structure editor,
 * the blank calculation and the FABRICATION order all look past them, leaving
 * the cutting order to claim exactly the tasks the others declined.
 *
 * ── ORDER_LINE_ID IS NULL, DELIBERATELY ──────────────────────────────────────
 *
 * A blank belongs to the JOB, not to one line of it. The same rectangle is
 * usually cut for both spans, and filing it under the first line would make the
 * second line's parts depend on the first line's steel for no reason anybody
 * could see. It also keeps blanks out of every per-line structure read, which
 * is most of them.
 */
export async function acceptNestingPlan(companyId, orderId, plan = {}, existingConn = null) {
  /*
   * A PROVEN-ALIVE connection. A background run (nestingRunService) can spend
   * minutes packing before anyone presses Accept, and every pooled connection
   * has been idle that whole time — TiDB Cloud hangs up on an idle session, so
   * a plain `pool.getConnection()` can hand back a closed socket and the whole
   * accept dies on `beginTransaction()` for a reason that has nothing to do
   * with the plan (nestingSuggestService.acceptSuggestion hit this first).
   */
  const conn = existingConn ?? await getLiveConnection();
  const owned = !existingConn;
  try {
    if (owned) await conn.beginTransaction();

    const mat = await materialiseBlanks(companyId, orderId, conn);
    if (!mat.blanks.length) {
      const e = new Error('Nothing on this order can be nested yet — no part has a size on it.');
      e.status = 400; throw e;
    }

    const [[cuttingFlow]] = await conn.query(
      `SELECT id FROM fab_operation_flows
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, CUTTING_FLOW_CODE],
    );
    if (!cuttingFlow) {
      const e = new Error(`No cutting flow (${CUTTING_FLOW_CODE}) to put this work on.`);
      e.status = 500; throw e;
    }

    // ── the blank rows, one per rectangle ──────────────────────────────────
    const [existing] = await conn.query(
      `SELECT i.id, i.catalog_item_id AS catalogItemId, i.qty, i.flow_id AS flowId
         FROM fab_items i
         JOIN fab_item_catalog c ON c.id = i.catalog_item_id
        WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
          AND i.node_kind = 'structure' AND c.material_form = 'blank'`,
      [companyId, orderId],
    );
    const rowByCatalog = new Map(existing.map((r) => [Number(r.catalogItemId), r]));

    let rowsCreated = 0;
    let rowsUpdated = 0;
    const blankRowId = new Map();

    for (const b of mat.blanks) {
      // The flow is per BLANK, not per sheet: a rectangle that also gets
      // drilled while it is flat is a property of the rectangle.
      const flowId = Number(plan?.flows?.[b.key]) || cuttingFlow.id;
      const was = rowByCatalog.get(Number(b.catalogItemId));

      if (was) {
        if (Number(was.qty) !== b.qty || Number(was.flowId) !== flowId) {
          await conn.query(
            `UPDATE fab_items SET qty = ?, flow_id = ?, name = ? WHERE id = ? AND company_id = ?`,
            [b.qty, flowId, b.name, was.id, companyId],
          );
          rowsUpdated += 1;
        }
        blankRowId.set(b.key, Number(was.id));
      } else {
        const [r] = await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id)
           VALUES (?,?,NULL,NULL,?,?,'nos',?,?,'structure',0,0,'make',?)`,
          [companyId, orderId, b.catalogItemId, b.name, b.qty, b.code, flowId],
        );
        blankRowId.set(b.key, r.insertId);
        rowsCreated += 1;
      }
    }

    /*
     * VERIFY THE GEOMETRY BEFORE TOUCHING ANYTHING. Until now `acceptNestingPlan`
     * wrote the request's own `n.length`/`n.width` straight onto the material
     * rows and never asked whether the pieces named actually fit the plate
     * named, or whether the plate named even existed (a drop's negative
     * `plateCatalogItemId` looked up nothing in `fab_item_catalog` and was
     * silently skipped — the part it carried lost its material with no error).
     *
     * Everything here reads from the DB (catalogue / stock piece), never from
     * the request, and none of it writes — so a rejected plan leaves the order
     * exactly as it was.
     */
    const nests0 = Array.isArray(plan?.nests) ? plan.nests : [];
    const resolvePlate = await resolvePlatesForNests(conn, companyId, nests0);

    // What THIS BLANK already carries, read before anything is wiped — the
    // only way to tell a genuine re-nest (new sheets, same or larger coverage)
    // from a partial accept that quietly dropped one of several sheets a row
    // was split across (§13 "A part row is ATOMIC to one plate").
    const oldCovered = new Map();
    {
      const catalogIdToKey = new Map(mat.blanks.map((b) => [Number(b.catalogItemId), b.key]));
      const liveIds = [...catalogIdToKey.keys()];
      if (liveIds.length) {
        const [rows] = await conn.query(
          `SELECT b.catalog_item_id AS blankCatalogItemId, SUM(m.qty) AS qty
             FROM fab_items m
             JOIN fab_items b ON b.id = m.parent_item_id AND b.deleted_at IS NULL
            WHERE m.company_id = ? AND m.order_id = ? AND m.node_kind = 'material'
              AND m.deleted_at IS NULL AND b.catalog_item_id IN (?)
            GROUP BY b.catalog_item_id`,
          [companyId, orderId, liveIds],
        );
        for (const r of rows) {
          const key = catalogIdToKey.get(Number(r.blankCatalogItemId));
          if (key) oldCovered.set(key, Number(r.qty) || 0);
        }
      }
    }

    const byBlankKey = new Map(mat.blanks.map((b) => [b.key, b]));
    const newCovered = new Map();
    const packerPlates = [];
    const problems = [];
    const kerfCache = new Map();

    for (const n of nests0) {
      if (!Array.isArray(n.items) || !n.items.length) continue;
      const label = n.nestNo ?? '(unnumbered nest)';
      const info = resolvePlate(n);
      if (!info) { problems.push(`${label}: names a plate that is no longer in the catalog or stock.`); continue; }
      if (!Number.isFinite(info.thickness) || !Number.isFinite(info.length) || !Number.isFinite(info.width)) {
        problems.push(`${label}: plate ${info.code ?? info.catalogItemId} has no recorded size.`);
        continue;
      }
      const items = new Map();
      for (const it of n.items) items.set(it.key, (items.get(it.key) ?? 0) + (Number(it.qty) || 0));

      const rows = [];
      for (const [key, qty] of items) {
        const b = byBlankKey.get(key);
        if (!b) { problems.push(`${label}: names a blank this order no longer needs.`); continue; }
        for (const c of axisConflicts(
          { thickness: b.thickness, grade: b.grade, material: b.material },
          { thickness: info.thickness, grade: info.grade, material: info.material },
        )) {
          problems.push(`${label}: ${b.code} is ${c.partValue} but plate ${info.code ?? info.catalogItemId} `
            + `is ${c.plateValue} (${c.axis}).`);
        }
        rows.push({ key, length: b.length, width: b.width, qty });
        newCovered.set(key, (newCovered.get(key) ?? 0) + qty);
      }
      if (rows.length) {
        const kerfMm = await kerfFor(companyId, info.thickness, 'cutting', kerfCache);
        /*
         * THE LAYOUT TRAVELS WITH THE PLAN. A sheet that arrives with its
         * pieces (every packer run sends them) is verified exactly — inside
         * the sheet, no overlaps, the right sizes and counts — instead of
         * being re-solved from empty, which could refuse a layout the search
         * only found by trying. A hand-made sheet has no pieces and is still
         * re-packed to prove it.
         */
        const pieces = Array.isArray(n.pieces) && n.pieces.length
          ? n.pieces.map((q) => ({
            key: String(q.key), x: Number(q.x), y: Number(q.y), l: Number(q.l), w: Number(q.w), rotated: !!q.rotated,
          })).filter((q) => [q.x, q.y, q.l, q.w].every(Number.isFinite))
          : undefined;
        packerPlates.push({
          spec: { id: info.catalogItemId, length: info.length, width: info.width, code: info.code },
          rows, margin: kerfMm, pieces,
        });
      }
    }

    // The packer's own honesty check (EU-10: repacks each plate's FULL row set
    // from empty) — does every piece named actually fit the plate named, and
    // does the plate hold no more area than it has.
    for (const p of verifyPacking(packerPlates)) problems.push(p);

    const EPS = 1e-6;
    for (const b of mat.blanks) {
      const placed = newCovered.get(b.key) ?? 0;
      const was = oldCovered.get(b.key) ?? 0;
      if (placed > b.qty + EPS) {
        problems.push(`${b.code}: this plan nests ${placed} of it but only ${b.qty} are needed `
          + '(demand already includes line quantity).');
      } else if (was - placed > EPS && b.qty - placed > EPS) {
        // Was covered by MORE than this plan covers, and is still short of
        // demand either way — the signature of "un-ticked" a sheet rather than
        // a deliberate reduction in what the order needs.
        problems.push(`${b.code}: was cut ${was} of ${b.qty}; this plan only covers ${placed}. `
          + 'A part row is atomic to one plate — accept every sheet it is split across, or none.');
      }
    }

    if (problems.length) {
      const e = new Error(`This plan could not be verified:\n${problems.slice(0, 12).join('\n')}`
        + (problems.length > 12 ? `\n…and ${problems.length - 12} more` : ''));
      e.status = 422; e.code = 'NEST_NOT_VERIFIED'; e.detail = { nests: problems };
      throw e;
    }

    /*
     * A rectangle the order no longer needs takes its row with it. Editing the
     * structure changes which blanks exist, and a cutting line for something
     * nobody is making would still be scheduled and still draw plate.
     */
    const liveCatalogIds = mat.blanks.map((b) => Number(b.catalogItemId));
    const stale = existing.filter((r) => !liveCatalogIds.includes(Number(r.catalogItemId)));
    if (stale.length) {
      const ids = stale.map((r) => r.id);
      const [[worked]] = await conn.query(
        `SELECT COUNT(*) AS n FROM fab_project_tasks
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL
            AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
        [companyId, ids],
      );
      if (worked.n > 0) {
        const e = new Error(
          `Refused: ${worked.n} cutting task(s) for blanks this order no longer needs have `
          + 'already been started. Re-nesting would throw that away.');
        e.status = 409; e.code = 'WORK_STARTED'; throw e;
      }
      await conn.query(
        `UPDATE fab_project_tasks SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`, [companyId, ids]);
      await conn.query(
        `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND (id IN (?) OR parent_item_id IN (?)) AND deleted_at IS NULL`,
        [companyId, ids, ids]);
    }

    // ── the sheets, and what each carries ──────────────────────────────────
    /*
     * A NEST IS A SHEET, and a sheet holds several rectangles. So this writes
     * one material row per (blank, sheet) pair, all the rows for one sheet
     * SHARING a `nest_no`.
     *
     * That shared number is load-bearing downstream: `wipInventoryService
     * .claimNest` issues raw material on a link carrying a nest_no ONCE for the
     * whole nest, because the shop takes one plate to the machine and cuts
     * everything out of it. Writing a row per blank without sharing the number
     * would draw the same physical sheet from stock once per rectangle on it.
     */
    const rowIds = [...blankRowId.values()];
    if (rowIds.length) {
      await conn.query(
        `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND parent_item_id IN (?) AND node_kind = 'material'
            AND deleted_at IS NULL`,
        [companyId, rowIds],
      );
    }

    let platesLinked = 0;
    // `sheets` (nextNestNo's high-water mark, +1 per row below) is the counter
    // that NAMES each new sheet — that logic is unchanged. `sheetsWritten` is
    // a separate count of sheets this accept actually wrote, which is what
    // `out.sheets` reports: `sheets` alone is the LAST nest number on the
    // whole order, not how many this call added, whenever the order already
    // had other nested parts before this accept ran.
    let sheets = await nextNestNo(conn, companyId, orderId);
    let sheetsWritten = 0;
    let offcutsClaimed = 0;
    for (const n of nests0) {
      if (!Array.isArray(n.items) || !n.items.length) continue;
      // Already proved to resolve, above — verification and the write below
      // must agree on what a nest names, or a plan could pass the check and
      // write something else.
      const info = resolvePlate(n);
      if (!info) continue;
      sheets += 1;
      sheetsWritten += 1;
      const nestNo = n.nestNo ?? `N-${String(sheets).padStart(3, '0')}`;

      /*
       * MERGED HERE TOO, because a hand-made sheet can name the same blank on
       * two rows just as easily as the packer can. One (blank, sheet) is one
       * material row, and two of them collide on the unique code.
       */
      const items = new Map();
      for (const it of n.items) {
        items.set(it.key, (items.get(it.key) ?? 0) + (Number(it.qty) || 0));
      }

      let piecesOnThisSheet = 0;
      for (const [itemKey, itemQty] of items) {
        const it = { key: itemKey, qty: itemQty };
        const parentId = blankRowId.get(it.key);
        if (!parentId) continue;
        const blank = mat.blanks.find((x) => x.key === it.key);
        await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type,
              flow_id, nest_no, length, width, height)
           VALUES (?,?,NULL,?,?,?,'nos',?,?,'material',1,1,'buy',NULL,?,?,?,?)`,
          [companyId, orderId, parentId, info.catalogItemId, info.name ?? info.code, Number(it.qty) || 1,
            `${blank?.code ?? it.key}-${info.code ?? info.catalogItemId}-${nestNo}`, nestNo,
            info.length, info.width, info.thickness],
        );
        platesLinked += 1;
        piecesOnThisSheet += Number(it.qty) || 0;
      }

      /*
       * A DROP IS ONE PHYSICAL PIECE, SO ACCEPTING A NEST ON ONE CLAIMS IT.
       *
       * Moved from `nestingSuggestService.acceptSuggestion` (deleted whole in
       * EU-20) — the suggestor reserved a drop it nested onto; the blank path
       * reserved nothing, so two orders could each plan around the same
       * offcut and only one would find steel at the torch. Conditional on the
       * piece still being free, so two accepts racing cannot both claim it —
       * the loser is told rather than silently given someone else's plate.
       */
      if (info.isDrop && info.pieceId && piecesOnThisSheet > 0) {
        // The INSERT…SELECT below is a NOT EXISTS read against
        // fab_stock_reservations, which has only a non-unique index — nothing
        // stops two accepts racing on the same offcut from both reading "free"
        // before either writes. Locking the stock piece row itself is what
        // actually serializes them: the second transaction blocks here until
        // the first commits (and its reservation becomes visible) or rolls back.
        await conn.query(
          'SELECT id FROM fab_stock_pieces WHERE id = ? AND company_id = ? FOR UPDATE',
          [info.pieceId, companyId],
        );
        const [claim] = await conn.query(
          // kind='order', not the column's default of 'task': the ORDER is
          // laying claim to a piece at planning time, before any task exists
          // to hold it.
          `INSERT INTO fab_stock_reservations
             (company_id, order_id, catalog_item_id, stock_piece_id, qty, status, kind, notes, created_at)
           SELECT ?, ?, ?, p.id, p.qty, 'active', 'order',
                  CONCAT('nested onto offcut ', COALESCE(p.code, p.id)), UTC_TIMESTAMP()
             FROM fab_stock_pieces p
            WHERE p.id = ? AND p.company_id = ? AND p.status = 'in_stock' AND p.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM fab_stock_reservations r
                               WHERE r.stock_piece_id = p.id AND r.status = 'active'
                                 AND r.deleted_at IS NULL)`,
          [companyId, orderId, info.catalogItemId, info.pieceId, companyId],
        );
        if (!claim.affectedRows) {
          const e = new Error(
            `Offcut ${info.code ?? info.pieceId} has just been claimed by another order, so ${nestNo} `
            + 'is no longer free. Re-run the plan.');
          e.status = 409; e.code = 'OFFCUT_CLAIMED'; throw e;
        }
        offcutsClaimed += 1;
      }
    }

    /*
     * ── THE ACCEPTED LAYOUTS, KEPT ──────────────────────────────────────────
     *
     * The material rows above record WHAT is on each sheet (qty per blank per
     * nest_no), never WHERE. So an accepted plan used to be drawn back from a
     * fresh re-pack of each sheet — a display layout, not the one accepted,
     * and one that could even fail to fit. The per-piece geometry that came
     * with the plan is kept here, on a `fab_nesting_runs` row of its own kind,
     * keyed by nest_no; `blankPlanService.savedNests` reads it back and only
     * falls back to re-packing when a sheet has no layout on record (a hand-
     * made sheet, or a plan accepted before layouts were kept).
     */
    const layouts = nests0
      .filter((n) => Array.isArray(n.items) && n.items.length && Array.isArray(n.pieces) && n.pieces.length)
      .map((n) => ({
        nestNo: n.nestNo ?? null,
        plateCatalogItemId: resolvePlate(n)?.catalogItemId ?? null,
        length: Number(n.length) || null,
        width: Number(n.width) || null,
        items: n.items.map((it) => ({ key: it.key, qty: Number(it.qty) || 0 })),
        pieces: n.pieces.map((q) => ({
          key: String(q.key), x: Number(q.x), y: Number(q.y), l: Number(q.l), w: Number(q.w), rotated: !!q.rotated,
        })),
      }))
      .filter((n) => n.nestNo);
    await conn.query(
      `UPDATE fab_nesting_runs SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id = ? AND order_id = ? AND kind = 'accepted' AND deleted_at IS NULL`,
      [companyId, orderId],
    );
    if (layouts.length) {
      await conn.query(
        `INSERT INTO fab_nesting_runs
           (company_id, order_id, kind, effort, status, progress, params_json, result_json,
            started_at, finished_at, created_at)
         VALUES (?,?,'accepted',NULL,'done',100,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
        [companyId, orderId, JSON.stringify({ provenance: plan?.provenance ?? null }), JSON.stringify({ nests: layouts })],
      );
    }

    // ── every part now comes off its blank, not off plate ──────────────────
    let partsRepointed = 0;
    for (const b of mat.blanks) {
      for (const part of b.parts) {
        await conn.query(
          `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
            WHERE company_id = ? AND parent_item_id = ? AND node_kind = 'material'
              AND deleted_at IS NULL`,
          [companyId, part.itemId],
        );
        await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type,
              flow_id, length, width, height)
           SELECT ?, order_id, order_line_id, ?, ?, ?, 'nos', ?, ?, 'material', depth + 1, 1,
                  'make', NULL, ?, ?, ?
             FROM fab_items WHERE id = ? AND company_id = ?`,
          [companyId, part.itemId, b.catalogItemId, b.name, part.qty,
            `${b.code}-${part.itemId}`, b.length, b.width, b.thickness,
            part.itemId, companyId],
        );
        partsRepointed += 1;
      }
    }

    // ── the work, and the order that owns it ───────────────────────────────
    const materialized = await materializeOrderTasks(conn, companyId, orderId);
    const po = await ensureCuttingOrder(companyId, orderId, conn);

    /*
     * WEIGH IT NOW. Every material link on the order was just rewritten, and
     * weight is read off those links; leaving the roll-up for a later button
     * press meant the order screen showed the pre-nesting figures until then,
     * and any bug in the links above stayed invisible.
     */
    const weights = await recomputeOrderWeights(companyId, orderId, conn);

    /*
     * RECORD HOW THIS PLAN WAS ARRIVED AT, so the screen can say so later.
     * "Deep — 2000 restarts in 14.2s", or "Uploaded from a spreadsheet". Without
     * it, an accepted plan is a set of sheets with no account of where it came
     * from, and the first question anybody asks about a plan is why it looks
     * like that.
     */
    if (plan?.provenance) {
      await conn.query(
        `UPDATE fab_orders SET notes = ? WHERE id = ? AND company_id = ?`,
        [`Plate to blanks for ${po.sales?.orderNumber ?? orderId} \u00b7 ${plan.provenance}`,
          po.id, companyId],
      );
    }

    if (owned) await conn.commit();
    const out = {
      cuttingOrderId: po.id,
      cuttingOrderNumber: po.orderNumber,
      cuttingOrderCreated: po.created,
      blanks: mat.blanks.length,
      blanksCreated: mat.created,
      blanksRetired: mat.retired ?? 0,
      rowsCreated,
      rowsUpdated,
      rowsRetired: stale.length,
      platesLinked,
      sheets: sheetsWritten,
      offcutsClaimed,
      partsRepointed,
      tasks: materialized?.tasksInserted ?? 0,
      tasksClaimed: po.tasksClaimed ?? 0,
      totalWeightKg: weights.totalWeight,
      unweighedLeaves: weights.unweighedLeaves,
      skipped: mat.skipped,
    };
    logger.info({ companyId, orderId, ...out }, 'fab_erp: nesting plan accepted');
    return out;
  } catch (err) {
    if (owned) {
      /*
       * LOGGED, NEVER SWALLOWED. A dead socket makes `rollback()` itself throw
       * ("Can't add new command when connection is in closed state"), and that
       * secondary error used to replace the real one — a 409 for an offcut
       * already claimed, or the 422 below, silently became a 500 about a
       * closed connection. The transaction is gone either way once the socket
       * is; there is nothing left to undo, but there IS something to log.
       */
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        logger.warn({ err: rollbackErr, companyId, orderId },
          'fab_erp: rollback failed after a nesting accept error (connection likely dead)');
      }
    }
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
