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

import { pool } from '../../../db.js';
import { resolveFields } from './fieldService.js';
import { resolveItemFields } from './itemFieldService.js';
import { DEFAULT_DENSITY } from './fieldDeriveService.js';
import { NOT_A_BLANK, IS_A_BLANK } from './blankPredicate.js';

export { NOT_A_BLANK } from './blankPredicate.js';
import { materializeOrderTasks } from './taskGatingService.js';
import { logger } from '../../../core/utils/logger.js';

/** The flow a blank is cut by, unless the plan names another. */
export const CUTTING_FLOW_CODE = 'C0001';

/** Where blanks are filed. The group is expected to exist; the subgroup is per order. */
const BLANK_CATEGORY = 'Raw Materials';
const BLANK_GROUP = 'Blanks';

/** Codes are DERIVED, so the same rectangle on the same order is always the same code. */
const codeBit = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function blankCode(orderNumber, { material, grade, thickness, width, length }) {
  return [
    'BLK',
    // "SO-20260910-0066" -> "202609100066". The prefix says "sales order" on a
    // code that already begins BLK, so it earns nothing but length.
    codeBit(String(orderNumber).replace(/^[A-Za-z]+-/, '')),
    codeBit(material) || 'X',
    codeBit(grade) || 'X',
    `${thickness}X${width}X${length}`,
  ].join('-');
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
        AND COALESCE(p.procurement_type, 'make') = 'make'
        AND NOT EXISTS (
          SELECT 1 FROM fab_items k
           WHERE k.parent_item_id = p.id AND k.deleted_at IS NULL
             AND NOT k.node_kind = 'material')
        -- A blank is childless apart from its plate, so without this it reads
        -- as a made leaf and the order grows blanks of blanks on every re-nest.
        AND ${NOT_A_BLANK('p')}
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
    `SELECT id, parent_item_id AS parentItemId, qty FROM fab_items
      WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        AND NOT node_kind = 'material'`,
    [companyId, orderId],
  );
  const nodeById = new Map(allRows.map((r) => [Number(r.id), r]));
  const rolledQty = (partId) => {
    let multiplier = 1;
    let at = nodeById.get(Number(partId));
    for (let hops = 0; at && hops < 64; hops += 1) {   // cycle guard, not optimism
      multiplier *= Number(at.qty) || 0;
      if (at.parentItemId == null) break;
      at = nodeById.get(Number(at.parentItemId));
    }
    return Math.round(multiplier);
  };

  const ids = parts.map((p) => Number(p.id));
  const nums = await resolveItemFields(companyId, ids, { conn: existingConn ?? undefined });
  // Material and grade are TEXT, which the numbers-only resolver cannot carry.
  const text = await resolveFields(
    companyId, ids.map((id) => ({ scope: 'order_item', scopeId: id })),
    { conn: existingConn ?? undefined },
  );

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

    const density = Number.isFinite(Number(n.density_kg_m3)) ? Number(n.density_kg_m3) : DEFAULT_DENSITY;
    const shape = { material: String(material), grade: String(grade), thickness, width, length };
    const key = blankKey(shape);
    const qty = rolledQty(p.id);

    const hit = byKey.get(key) ?? {
      ...shape,
      key,
      qty: 0,
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
  for (const b of blanks) {
    b.code = blankCode(order.orderNumber, b);
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
         VALUES (?,?,?,?,?,NOW())`,
        [companyId, group.id, orderNumber, `BLK-${codeBit(String(orderNumber).replace(/^[A-Za-z]+-/, ''))}`,
          `Blanks cut for ${orderNumber}`],
      );
      sub = { id: r.insertId };
    } else {
      await conn.query(`UPDATE fab_item_subgroups SET deleted_at = NULL WHERE id = ?`, [sub.id]);
    }

    const [fields] = await conn.query(
      `SELECT id, field_key, default_unit FROM fab_fields
        WHERE company_id = ? AND deleted_at IS NULL
          AND field_key IN ('thickness_mm','width_mm','length_mm','material','grade','unit_weight_kg')`,
      [companyId],
    );
    const fieldOf = new Map(fields.map((f) => [f.field_key, f]));

    let created = 0;
    let updated = 0;

    for (const b of blanks) {
      const [[existing]] = await conn.query(
        `SELECT id FROM fab_item_catalog WHERE company_id = ? AND code = ? LIMIT 1`,
        [companyId, b.code],
      );
      if (existing) {
        await conn.query(
          `UPDATE fab_item_catalog
              SET name = ?, unit = 'nos', category_id = ?, group_id = ?, subgroup_id = ?,
                  procurement_type = 'make', thickness_mm = ?, material_form = 'blank',
                  deleted_at = NULL
            WHERE id = ? AND company_id = ?`,
          [b.name, group.categoryId, group.id, sub.id, b.thickness, existing.id, companyId],
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
              procurement_type, thickness_mm, material_form, description, created_at)
           VALUES (?,?,?,'nos',?,?,?,'make',?,'blank',?,NOW())`,
          [companyId, b.name, b.code, group.categoryId, group.id, sub.id, b.thickness,
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
       */
      const vals = [
        ['thickness_mm', b.thickness, null], ['width_mm', b.width, null], ['length_mm', b.length, null],
        ['unit_weight_kg', b.unitWeightKg, null],
        ['material', null, b.material], ['grade', null, b.grade],
      ];
      for (const [key, num, txt] of vals) {
        const f = fieldOf.get(key);
        if (!f) continue;
        await conn.query(
          `INSERT INTO fab_field_values
             (company_id, field_id, scope, scope_id, value_num, value_text, unit_code, created_at)
           VALUES (?,?,'catalog_item',?,?,?,?,NOW())
           ON DUPLICATE KEY UPDATE
             value_num = VALUES(value_num), value_text = VALUES(value_text), deleted_at = NULL`,
          [companyId, f.id, b.catalogItemId, num, txt, f.default_unit ?? null],
        );
      }
    }

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
        `UPDATE fab_item_catalog SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)`,
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
    const [[{ ymd }]] = await conn.query("SELECT DATE_FORMAT(UTC_DATE(), '%Y%m%d') AS ymd");
    const [[seq]] = await conn.query(
      `SELECT COUNT(*) AS n FROM fab_orders
        WHERE company_id = ? AND order_type = 'manufacturing' AND mo_purpose = 'cutting'`,
      [companyId],
    );
    const orderNumber = `MO-CUT-${ymd}-${String(Number(seq.n) + 1).padStart(4, '0')}`;
    const [ins] = await conn.query(
      `INSERT INTO fab_orders
         (company_id, order_number, order_type, mo_purpose, status, source_order_id,
          plant_id, required_date, notes, created_at)
       VALUES (?,?,'manufacturing','cutting','draft',?,?,?,?,NOW())`,
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

  return { ...mo, created, tasksClaimed: claim?.affectedRows ?? 0 };
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
  const conn = existingConn ?? await pool.getConnection();
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
        `UPDATE fab_project_tasks SET deleted_at = NOW()
          WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL`, [companyId, ids]);
      await conn.query(
        `UPDATE fab_items SET deleted_at = NOW()
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
        `UPDATE fab_items SET deleted_at = NOW()
          WHERE company_id = ? AND parent_item_id IN (?) AND node_kind = 'material'
            AND deleted_at IS NULL`,
        [companyId, rowIds],
      );
    }

    const nests = Array.isArray(plan?.nests) ? plan.nests : [];
    let platesLinked = 0;
    let sheets = 0;
    for (const n of nests) {
      if (!n?.plateCatalogItemId || !Array.isArray(n.items) || !n.items.length) continue;
      const [[pc]] = await conn.query(
        `SELECT id, code, name, thickness_mm AS thickness FROM fab_item_catalog
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [n.plateCatalogItemId, companyId],
      );
      if (!pc) continue;
      sheets += 1;
      const nestNo = n.nestNo ?? `N-${String(sheets).padStart(3, '0')}`;

      for (const it of n.items) {
        const parentId = blankRowId.get(it.key);
        if (!parentId) continue;
        const blank = mat.blanks.find((x) => x.key === it.key);
        await conn.query(
          `INSERT INTO fab_items
             (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type,
              flow_id, nest_no, length, width, height)
           VALUES (?,?,NULL,?,?,?,'nos',?,?,'material',1,1,'buy',NULL,?,?,?,?)`,
          [companyId, orderId, parentId, pc.id, pc.name, Number(it.qty) || 1,
            `${blank?.code ?? it.key}-${pc.code}-${nestNo}`, nestNo,
            n.length ?? null, n.width ?? null, pc.thickness ?? null],
        );
        platesLinked += 1;
      }
    }

    // ── every part now comes off its blank, not off plate ──────────────────
    let partsRepointed = 0;
    for (const b of mat.blanks) {
      for (const part of b.parts) {
        await conn.query(
          `UPDATE fab_items SET deleted_at = NOW()
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
      sheets,
      partsRepointed,
      tasks: materialized?.tasksInserted ?? 0,
      tasksClaimed: po.tasksClaimed ?? 0,
      skipped: mat.skipped,
    };
    logger.info({ companyId, orderId, ...out }, 'fab_erp: nesting plan accepted');
    return out;
  } catch (err) {
    if (owned) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}
