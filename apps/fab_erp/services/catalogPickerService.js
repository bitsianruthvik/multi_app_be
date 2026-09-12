/**
 * catalogPickerService.js — enough about an item to know it is the right one.
 *
 * The add-a-row picker on an order used to offer a name and its taxonomy, and
 * nothing else: "Top Flange · Fabricated › Composite Girder › Parts". Two items
 * with plain names were indistinguishable, and the only way to tell a live item
 * from a stray one was to leave the order and go looking.
 *
 * So the picker gets what a person actually decides on:
 *
 *   what it is     size, material and grade, make or bought
 *   how it is made the flow its BOM lines usually give it
 *   is it real     how many BOMs and how many orders use it, and when last
 *
 * ONE QUERY PER FACT, not per item. An order picker opening a thousand items
 * must not cost a thousand round trips to TiDB.
 */

import { pool } from '../../../db.js';

/** Categories a structure row can hold. Raw material arrives through nesting. */
const ADDABLE = ['Fabricated', 'Fasteners & Hardware', 'Consumables'];

/** Sizes and material, straight off the field registry, for every item at once. */
export async function catalogSizes(companyId, ids = null) {
  const scope = ids && ids.length ? 'AND v.scope_id IN (?)' : '';
  const [rows] = await pool.query(
    `SELECT v.scope_id AS id, f.field_key AS k, v.value_num AS n, v.value_text AS t
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
      WHERE v.company_id = ? AND v.scope = 'catalog_item' AND v.deleted_at IS NULL ${scope}
        AND f.field_key IN ('thickness_mm','width_mm','length_mm','material','grade')`,
    ids && ids.length ? [companyId, ids] : [companyId],
  );
  const out = new Map();
  for (const r of rows) {
    const e = out.get(Number(r.id)) ?? {};
    e[r.k] = r.n == null ? r.t : Number(r.n);
    out.set(Number(r.id), e);
  }
  return out;
}

/** "32 × 90 × 1700", or as much of it as the item states. */
const sizeText = (s) => {
  const parts = [s?.thickness_mm, s?.width_mm, s?.length_mm].filter((x) => x != null && x !== '');
  return parts.length ? parts.join(' × ') : null;
};

/**
 * Everything a structure row may point at, with what it takes to choose.
 *
 * @param {number} [orderId] marks the items this order already uses, so the
 *   picker can offer them first — on a bridge order the next row is nearly
 *   always a part the order already has.
 */
export async function pickableItems(companyId, orderId = null) {
  const [items] = await pool.query(
    `SELECT c.id, c.name, c.code, c.unit, c.description, c.thickness_mm AS thicknessCol,
            COALESCE(c.procurement_type, 'make') AS procurement,
            cat.name AS categoryName, g.name AS groupName, sg.name AS subgroupName
       FROM fab_item_catalog c
       JOIN fab_item_categories cat ON cat.id = c.category_id AND cat.deleted_at IS NULL
       LEFT JOIN fab_item_groups g ON g.id = c.group_id AND g.deleted_at IS NULL
       LEFT JOIN fab_item_subgroups sg ON sg.id = c.subgroup_id AND sg.deleted_at IS NULL
      WHERE c.company_id = ? AND c.deleted_at IS NULL AND cat.name IN (?)
      ORDER BY c.name`,
    [companyId, ADDABLE],
  );
  if (!items.length) return [];
  const ids = items.map((i) => Number(i.id));

  const [[sizes], [bom], [orders], [flows], [mine]] = await Promise.all([
    catalogSizes(companyId, ids).then((m) => [m]),
    pool.query(
      `SELECT child_item_id AS id, COUNT(*) AS n FROM fab_item_bom
        WHERE company_id = ? AND deleted_at IS NULL AND child_item_id IN (?) GROUP BY child_item_id`,
      [companyId, ids],
    ),
    pool.query(
      `SELECT i.catalog_item_id AS id, COUNT(DISTINCT i.order_id) AS n, MAX(i.created_at) AS lastUsed
         FROM fab_items i
         JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
        WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.catalog_item_id IN (?)
        GROUP BY i.catalog_item_id`,
      [companyId, ids],
    ),
    // The flow its BOM lines give it — what the shop usually does to it.
    pool.query(
      `SELECT b.child_item_id AS id, f.name AS flowName, COUNT(*) AS n
         FROM fab_item_bom b
         JOIN fab_operation_flows f ON f.id = b.default_flow_id AND f.deleted_at IS NULL
        WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.child_item_id IN (?)
        GROUP BY b.child_item_id, f.name ORDER BY n DESC`,
      [companyId, ids],
    ),
    orderId
      ? pool.query(
        `SELECT DISTINCT catalog_item_id AS id FROM fab_items
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL AND catalog_item_id IS NOT NULL`,
        [companyId, orderId],
      )
      : Promise.resolve([[]]),
  ]);

  const bomOf = new Map(bom.map((r) => [Number(r.id), Number(r.n)]));
  const orderOf = new Map(orders.map((r) => [Number(r.id), r]));
  const flowOf = new Map();
  for (const f of flows) if (!flowOf.has(Number(f.id))) flowOf.set(Number(f.id), f.flowName);
  const onThisOrder = new Set(mine.map((r) => Number(r.id)));

  return items.map((it) => {
    const s = sizes.get(Number(it.id)) ?? {};
    const used = orderOf.get(Number(it.id));
    return {
      id: Number(it.id),
      name: it.name,
      code: it.code,
      unit: it.unit,
      categoryName: it.categoryName,
      groupName: it.groupName,
      subgroupName: it.subgroupName,
      procurement: it.procurement,
      size: sizeText({ ...s, thickness_mm: s.thickness_mm ?? it.thicknessCol }),
      material: [s.material, s.grade].filter(Boolean).join(' ') || null,
      flowName: flowOf.get(Number(it.id)) ?? null,
      bomCount: bomOf.get(Number(it.id)) ?? 0,
      orderCount: used ? Number(used.n) : 0,
      lastUsedAt: used?.lastUsed ?? null,
      onThisOrder: onThisOrder.has(Number(it.id)),
    };
  });
}
