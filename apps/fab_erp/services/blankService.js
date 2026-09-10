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
 */

import { pool } from '../../../db.js';
import { resolveFields } from './fieldService.js';
import { resolveItemFields } from './itemFieldService.js';
import { DEFAULT_DENSITY } from './fieldDeriveService.js';

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
          `INSERT INTO fab_item_catalog
             (company_id, name, code, unit, category_id, group_id, subgroup_id,
              procurement_type, thickness_mm, material_form, description, created_at)
           VALUES (?,?,?,'nos',?,?,?,'make',?,'blank',?,NOW())`,
          [companyId, b.name, b.code, group.categoryId, group.id, sub.id, b.thickness,
            `Cut for ${orderNumber}. Used by: ${b.parts.map((p) => p.name).join(', ')}`],
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
