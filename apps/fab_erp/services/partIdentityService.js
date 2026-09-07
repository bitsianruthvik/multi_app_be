/**
 * partIdentityService.js — a part is named by WHAT IT IS, not by where it sits.
 *
 * ── THE DISTINCTION ───────────────────────────────────────────────────────
 * An assembly earns a positional code because that specific object goes in that
 * specific place: ED3 sits at one end of the bridge and ED4 at the other, and if
 * ED3 fails inspection it is ED3 that failed. A part has no such claim. Once a
 * stiffener is cut it goes on a pile with the others and nobody can tell them
 * apart again, so coding it by its position in the tree asserted a difference
 * that stops existing at the torch — and that assertion had a price. Two
 * identical stiffeners under two different diaphragms were two separate things
 * to nest, to buy and to stock, so the same steel was planned many times over.
 * On the KEPL order 1,090 part rows describe 25 distinct blanks.
 *
 * ── BLANK IS NOT PART, AND THE DIFFERENCE MATTERS ─────────────────────────
 * Material, grade and dimensions identify the BLANK. They do NOT identify the
 * part. Measured on that same order, six of the twenty-five blanks are shared by
 * parts that are not interchangeable:
 *
 *   12 x 170 x 2995   Intermediate Stiffener Plain   Part Fabrication — Plain
 *   12 x 170 x 2995   Intermediate Stiffener Hole    Part Fabrication — Drilled
 *
 * Same plate, different work. Merging those on size alone would have put 828
 * pieces on one code and silently dropped the drilling on some of them — the
 * same class of defect as the '/D' suffix once routing to the wrong flow.
 *
 * So the code carries the blank AND the finishing:
 *
 *   KLPT-SO-20260906-0005-MS-E350BO-12X0170X02995      plain
 *   KLPT-SO-20260906-0005-MS-E350BO-12X0170X02995/D    drilled
 *
 * The suffix is the shop's own existing convention, taken from the BOM line's
 * code segment, not a new notion invented here. Nesting and procurement strip it
 * and see blanks; tracking and marking keep it and see parts.
 *
 * ── WHY THE DIMENSIONS ARE SORTED ─────────────────────────────────────────
 * A part 200 x 3052 and one 3052 x 200 are the same plate turned round, and the
 * packer already tries both orientations. Coding them apart would create two
 * stock items for one object.
 */

import { pool } from '../../../db.js';
import { previewCode, defaultSegmentsFor } from './codegenService.js';
import { orderCodePrefix } from './itemCodeService.js';

/**
 * The finishing marker, e.g. `/D` for drilled.
 *
 * Read off the END of the existing code rather than from the flow, because the
 * code is what the shop already writes and what the drawings already carry. A
 * flow id would be an opaque number in a code somebody has to read aloud.
 */
export const finishingOf = (code) => {
  if (!code) return '';
  const slash = String(code).lastIndexOf('/');
  return slash === -1 ? '' : String(code).slice(slash);
};

/** The blank half of a part code — what is cut, bought and stocked. */
export const blankOf = (code) => {
  if (!code) return '';
  const slash = String(code).lastIndexOf('/');
  return slash === -1 ? String(code) : String(code).slice(0, slash);
};

/**
 * Every made leaf of an order, with what it is made of.
 *
 * `is_leaf` and `node_kind` do the work that used to need a name check, and
 * `procurement_type` keeps bought-whole items out: a stud is not cut from
 * anything, so it has no blank.
 */
export async function orderParts(companyId, orderId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT i.id, i.code, i.name, i.qty, i.parent_item_id AS parentItemId,
            i.catalog_item_id AS catalogItemId, i.order_line_id AS orderLineId,
            i.length, i.width, i.height AS thickness, i.flow_id AS flowId
       FROM fab_items i
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure' AND i.is_leaf = 1
        AND COALESCE(i.procurement_type, 'make') = 'make'
      ORDER BY i.id`,
    [companyId, orderId],
  );
  return rows;
}

/**
 * The identity code for one part.
 *
 * Material and grade are passed in rather than looked up, because the caller is
 * already resolving field values for every part and a per-part lookup here would
 * be a thousand round trips to learn what it already knows.
 */
export async function partCodeFor(companyId, part, { prefix, material, grade }) {
  const lo = Math.min(Number(part.length) || 0, Number(part.width) || 0);
  const hi = Math.max(Number(part.length) || 0, Number(part.width) || 0);
  const base = await previewCode(companyId, 'order_part', defaultSegmentsFor('order_part'), {
    orderPrefix: prefix,
    attributes: {
      material, grade,
      thickness: part.thickness,
      // Sorted, so a plate and the same plate turned round are one thing.
      width: lo,
      length: hi,
    },
  });
  return `${base}${finishingOf(part.code)}`;
}

/**
 * Give every part its identity, and merge the ones that turn out to be the same.
 *
 * WRITES NOTHING WITHOUT `apply`. The merge is destructive — rows are
 * soft-deleted and quantities summed — so the dry run reports exactly what it
 * would do and is the thing to read first.
 *
 * WHAT MERGING DOES:
 *   - the lowest-numbered row of each identity survives and takes the total qty
 *   - it moves to the order LINE's root, because it no longer belongs to one
 *     assembly
 *   - every assembly that wanted one gets a `fab_item_demand` row saying how
 *     many, which is the edge `parent_item_id` used to carry
 *   - the others are soft-deleted, along with any material rows they held,
 *     because a nesting done against the old rows describes steel for parts
 *     that no longer exist
 */
export async function consolidateParts(companyId, orderId, { apply = false, conn: outer = null } = {}) {
  const conn = outer ?? await pool.getConnection();
  const owned = !outer;
  try {
    if (owned && apply) await conn.beginTransaction();

    const prefix = await orderCodePrefix(companyId, orderId);
    const parts = await orderParts(companyId, orderId, conn);
    if (!parts.length) {
      if (owned && apply) await conn.commit();
      return { parts: 0, identities: 0, merged: 0, blanks: 0, groups: [] };
    }

    /**
     * `resolveFields`, not `resolveItemFields` — grade and material are TEXT and
     * the item resolver is numbers-only by contract. Reading them through the
     * wrong one returns nothing at all, silently, and every part codes as NA-NA.
     * It resolves the whole ladder, so a grade set once on the order line
     * reaches every part under it.
     */
    const { resolveFields } = await import('./fieldService.js');
    const fields = await resolveFields(
      companyId,
      parts.map((p) => ({ scope: 'order_item', scopeId: p.id })),
      {},
    );

    const byCode = new Map();
    for (const p of parts) {
      const f = fields.get(`order_item:${p.id}`) ?? {};
      const material = f.material?.value ?? null;
      const grade = f.grade?.value ?? null;
      const code = await partCodeFor(companyId, p, { prefix, material, grade });
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(p);
    }

    const groups = [...byCode.entries()].map(([code, members]) => ({
      code,
      blank: blankOf(code),
      keep: members[0],
      drop: members.slice(1),
      qty: members.reduce((a, m) => a + (Number(m.qty) || 1), 0),
      // Which assembly wanted how many — the edge that survives the merge.
      demand: members.reduce((map, m) => {
        if (m.parentItemId != null) {
          map.set(Number(m.parentItemId), (map.get(Number(m.parentItemId)) ?? 0) + (Number(m.qty) || 1));
        }
        return map;
      }, new Map()),
    }));

    const summary = {
      parts: parts.length,
      identities: groups.length,
      blanks: new Set(groups.map((g) => g.blank)).size,
      merged: groups.reduce((a, g) => a + g.drop.length, 0),
      pieces: groups.reduce((a, g) => a + g.qty, 0),
      groups: groups.map((g) => ({
        code: g.code, keptId: g.keep.id, name: g.keep.name,
        rows: g.drop.length + 1, qty: g.qty, assemblies: g.demand.size,
      })),
    };
    if (!apply) {
      if (owned) conn.release();
      return summary;
    }

    /** The line's root — depth 0 under the same order line. */
    const rootOf = new Map();
    const [roots] = await conn.query(
      `SELECT id, order_line_id AS orderLineId FROM fab_items
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND depth = 0`,
      [companyId, orderId],
    );
    for (const r of roots) rootOf.set(r.orderLineId == null ? null : Number(r.orderLineId), Number(r.id));

    for (const g of groups) {
      const keepId = Number(g.keep.id);
      const newParent = rootOf.get(g.keep.orderLineId == null ? null : Number(g.keep.orderLineId))
        ?? g.keep.parentItemId;

      await conn.query(
        `UPDATE fab_items SET code = ?, qty = ?, parent_item_id = ?, depth = 1
          WHERE id = ? AND company_id = ?`,
        [g.code, g.qty, newParent, keepId, companyId],
      );

      if (g.drop.length) {
        const dropIds = g.drop.map((d) => Number(d.id));
        // Their material rows go too: a nesting done against a row that no
        // longer exists is steel allocated to nothing.
        await conn.query(
          `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
            WHERE company_id = ? AND parent_item_id IN (?) AND deleted_at IS NULL`,
          [companyId, dropIds],
        );
        await conn.query(
          `UPDATE fab_items SET deleted_at = UTC_TIMESTAMP()
            WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
          [companyId, dropIds],
        );
      }

      for (const [assemblyId, qty] of g.demand) {
        await conn.query(
          `INSERT INTO fab_item_demand (company_id, order_id, assembly_item_id, part_item_id, qty)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE qty = VALUES(qty), deleted_at = NULL`,
          [companyId, orderId, assemblyId, keepId, qty],
        );
      }
    }

    if (owned && apply) await conn.commit();
    return summary;
  } catch (err) {
    if (owned && apply) await conn.rollback();
    throw err;
  } finally {
    if (owned) conn.release();
  }
}

/**
 * What an assembly needs, now that it no longer contains it.
 *
 * The tree used to answer this by listing an item's children. Consolidation
 * moved identical parts onto the line, so ED1 has no children at all and a
 * screen that asks the tree gets "nothing" — which is worse than an error,
 * because an empty diaphragm looks like a diaphragm with nothing wrong.
 *
 * Returns the parts and how many of each, plus what each part is cut from, so
 * the tree can show a real answer in the place the children used to be.
 */
export async function demandFor(companyId, assemblyItemIds, conn = null) {
  const exec = conn ?? pool;
  const ids = [...new Set((assemblyItemIds ?? []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  const [rows] = await exec.query(
    `SELECT d.assembly_item_id AS assemblyId, d.qty,
            p.id AS partId, p.code AS partCode, p.name AS partName,
            p.qty AS partTotalQty, p.length, p.width, p.height AS thickness,
            (SELECT COUNT(*) FROM fab_items m
              WHERE m.parent_item_id = p.id AND m.deleted_at IS NULL
                AND m.node_kind = 'material' AND m.nest_no IS NOT NULL) AS plateCount
       FROM fab_item_demand d
       JOIN fab_items p ON p.id = d.part_item_id AND p.deleted_at IS NULL
      WHERE d.company_id = ? AND d.assembly_item_id IN (?) AND d.deleted_at IS NULL
      ORDER BY p.code`,
    [companyId, ids],
  );
  const out = new Map();
  for (const r of rows) {
    const k = Number(r.assemblyId);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({
      partId: Number(r.partId),
      code: r.partCode,
      name: r.partName,
      /** How many THIS assembly needs. */
      qty: Number(r.qty),
      /** How many the whole order needs — the part is shared. */
      totalQty: r.partTotalQty == null ? null : Number(r.partTotalQty),
      length: r.length == null ? null : Number(r.length),
      width: r.width == null ? null : Number(r.width),
      thickness: r.thickness == null ? null : Number(r.thickness),
      /** How many plates it is cut from. More than one is normal now. */
      plateCount: Number(r.plateCount) || 0,
    });
  }
  return out;
}
