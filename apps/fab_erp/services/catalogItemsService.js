/**
 * catalogItemsService.js — what the Items grid asks of the catalog beyond
 * "list a page": size-aware search, filter facets, bulk edits, inline size
 * writes and the where-used readout.
 *
 * Lives beside `catalogPickerService` rather than inside it: that file answers
 * "is this the right item to PICK", this one answers "how do I find and fix
 * items in the CATALOG". Both read the same field store.
 */

import { pool } from '../../../db.js';
import { fieldRegistry, setFieldsBulk } from './fieldService.js';
import { recomputeCatalogWeight } from './fieldDeriveService.js';
import { itemUsage } from './catalogPickerService.js';
import { assertCataloged, kindWhere } from './catalogKind.js';

/** The three dimensions a catalog item states, in the order a size is spoken. */
const SIZE_KEYS = ['thickness_mm', 'width_mm', 'length_mm'];
/** The two text facts a steel item carries as field values. */
const STEEL_KEYS = ['material', 'grade'];

// ─────────────────────────────────────────────────────────────────────────
// Size-aware search
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse the search box the way a fabricator types it.
 *
 * Grammar (whitespace-insensitive, case-insensitive):
 *
 *   SIZE   := NUM (SEP NUM (SEP NUM)?)? 'mm'?        e.g. 25x1500, 25 x 1500 x 9000
 *   SEP    := 'x' | '×' | '*'
 *   THK    := NUM 'mm'                               e.g. 12mm, 12 mm
 *   GRADE  := 'E' DDD ('BO' | 'BR' | 'B0' | 'C')?    e.g. E350, E250BO, E410 BR
 *   TEXT   := everything left over                   matched against name/code
 *
 * One number in a SIZE is the thickness, two are thickness + width, three are
 * all of them — the order a plate is called out ("25 by 1500 by 9000"). A bare
 * number with no 'mm' and no separator is NOT a size: it is far more often
 * part of a code (RM01337) than a thickness, so it stays text.
 *
 * Returns the dimensions found (numbers), the grade fragments found (strings
 * to LIKE-match against the grade field) and the remaining free text.
 */
export function parseCatalogSearch(raw) {
  let s = String(raw ?? '').trim();
  const out = { thicknessMm: null, widthMm: null, lengthMm: null, grade: null, text: '' };
  if (!s) return out;

  const NUM = '(\\d+(?:\\.\\d+)?)';
  const SEP = '\\s*(?:x|×|\\*)\\s*';
  // Longest form first so "25 x 1500 x 9000" is not eaten as "25 x 1500".
  const sizeRe = new RegExp(`(?<![\\w.])${NUM}(?:${SEP}${NUM})?(?:${SEP}${NUM})?\\s*(mm)?(?![\\w.])`, 'i');
  const m = s.match(sizeRe);
  // A lone number only counts when it says 'mm' — see the grammar note.
  if (m && (m[2] != null || m[4] != null)) {
    out.thicknessMm = Number(m[1]);
    if (m[2] != null) out.widthMm = Number(m[2]);
    if (m[3] != null) out.lengthMm = Number(m[3]);
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
  }

  const gradeRe = /(?<![A-Z0-9])E(\d{3})\s*(BO|BR|B0|C)?(?![A-Z0-9])/i;
  const g = s.match(gradeRe);
  if (g) {
    out.grade = `E${g[1]}${g[2] ? ` ${g[2].toUpperCase().replace('B0', 'BO')}` : ''}`;
    s = s.slice(0, g.index) + ' ' + s.slice(g.index + g[0].length);
  }

  out.text = s.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * The WHERE fragments and params that make `parseCatalogSearch`'s result bite.
 *
 * Dimensions match the FIELD VALUES (thickness through its projected column,
 * width/length through `fab_field_values` on `idx_ffv_match`), OR the size
 * spelled out in the item's name — a section is named "Channel 100 x 50 x 5",
 * which reads as depth × flange × web, not thickness × width × length; without
 * the name fallback the parser's plate-shaped reading would hide every
 * section from a search that copies its own name.
 *
 * `alias` is the fab_item_catalog alias in the caller's query.
 */
export async function searchClauses(companyId, parsed, alias = 'fic') {
  const where = [];
  const params = [];
  const registry = await fieldRegistry(companyId);
  const fieldId = (key) => registry.byKey.get(key)?.id ?? null;

  const numMatch = (key, value) => {
    if (key === 'thickness_mm') {
      params.push(value);
      return `${alias}.thickness_mm = ?`;
    }
    const fid = fieldId(key);
    if (!fid) return '1 = 0';
    params.push(companyId, fid, value);
    return `EXISTS (SELECT 1 FROM fab_field_values sv WHERE sv.company_id = ? AND sv.field_id = ?
              AND sv.value_num = ? AND sv.scope = 'catalog_item' AND sv.scope_id = ${alias}.id AND sv.deleted_at IS NULL)`;
  };

  const dims = [['thickness_mm', parsed.thicknessMm], ['width_mm', parsed.widthMm], ['length_mm', parsed.lengthMm]]
    .filter(([, v]) => v != null);
  if (dims.length) {
    const fieldSide = dims.map(([k, v]) => numMatch(k, v)).join(' AND ');
    // The name fallback: "25 x 1500" as the catalog spells it, bounded so
    // "12" cannot hit "12000" and "25 x 1500" cannot hit "125 x 1500". A lone
    // number must be followed by " x <number>" — "12mm" as a name search would
    // otherwise match every "12000" long section by its length.
    const esc = (v) => String(v).replace('.', '\\.');
    const spelled = dims.map(([, v]) => esc(v)).join(' ?[x×] ?');
    const tail = dims.length === 1 ? ' ?[x×] ?[0-9]' : '([^0-9]|$)';
    params.push(`(^|[^0-9.])${spelled}${tail}`);
    where.push(`((${fieldSide}) OR ${alias}.name REGEXP ?)`);
  }

  if (parsed.grade) {
    const fid = fieldId('grade');
    if (fid) {
      params.push(companyId, fid, `%${parsed.grade.replace(' ', '%')}%`);
      where.push(`EXISTS (SELECT 1 FROM fab_field_values sg WHERE sg.company_id = ? AND sg.field_id = ?
                    AND sg.value_text LIKE ? AND sg.scope = 'catalog_item' AND sg.scope_id = ${alias}.id AND sg.deleted_at IS NULL)`);
    } else {
      // No grade field defined: the token can still find the item by name.
      params.push(`%${parsed.grade}%`);
      where.push(`${alias}.name LIKE ?`);
    }
  }

  if (parsed.text) {
    params.push(`%${parsed.text}%`, `%${parsed.text}%`);
    where.push(`(${alias}.name LIKE ? OR ${alias}.code LIKE ?)`);
  }
  return { where, params };
}

/** `material=MS` / `grade=E350 BO` — an exact match on the field's text value. */
export async function textFieldClause(companyId, key, value, alias = 'fic') {
  const registry = await fieldRegistry(companyId);
  const fid = registry.byKey.get(key)?.id;
  // A filter on a field the company never defined matches nothing, not everything.
  if (!fid) return { where: '1 = 0', params: [] };
  return {
    where: `EXISTS (SELECT 1 FROM fab_field_values tf_${key} WHERE tf_${key}.company_id = ? AND tf_${key}.field_id = ?
              AND tf_${key}.value_text = ? AND tf_${key}.scope = 'catalog_item' AND tf_${key}.scope_id = ${alias}.id AND tf_${key}.deleted_at IS NULL)`,
    params: [companyId, fid, String(value)],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Facets
// ─────────────────────────────────────────────────────────────────────────

/**
 * How many live items sit under each filter option — over the WHOLE catalog,
 * not the current result, so a dropdown reads "Plates (180)" the same way
 * whatever else is ticked. Cheap enough (six GROUP BYs on ~1.6k rows) that
 * a smarter cross-filtered version is not worth its complexity yet.
 */
export async function catalogFacets(companyId, { kind } = {}) {
  // Counted within the tab the page is showing, or a chip would read
  // "blank (43)" on the Catalog tab and lead to an empty list.
  const kindSql = kindWhere(kind, 'fab_item_catalog');
  const live = `company_id = ? AND deleted_at IS NULL${kindSql ? ` AND ${kindSql}` : ''}`;
  const kindSqlC = kindWhere(kind, 'c');
  const [[cats], [grps], [subs], [forms], [steel]] = await Promise.all([
    pool.query(`SELECT category_id AS id, COUNT(*) AS n FROM fab_item_catalog WHERE ${live} AND category_id IS NOT NULL GROUP BY category_id`, [companyId]),
    pool.query(`SELECT group_id AS id, COUNT(*) AS n FROM fab_item_catalog WHERE ${live} AND group_id IS NOT NULL GROUP BY group_id`, [companyId]),
    pool.query(`SELECT subgroup_id AS id, COUNT(*) AS n FROM fab_item_catalog WHERE ${live} AND subgroup_id IS NOT NULL GROUP BY subgroup_id`, [companyId]),
    pool.query(`SELECT material_form AS value, COUNT(*) AS n FROM fab_item_catalog WHERE ${live} AND material_form IS NOT NULL AND material_form <> '' GROUP BY material_form ORDER BY n DESC`, [companyId]),
    pool.query(
      `SELECT f.field_key AS k, v.value_text AS value, COUNT(*) AS n
         FROM fab_field_values v
         JOIN fab_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
         JOIN fab_item_catalog c ON c.id = v.scope_id AND c.company_id = v.company_id AND c.deleted_at IS NULL
                                ${kindSqlC ? `AND ${kindSqlC}` : ''}
        WHERE v.company_id = ? AND v.scope = 'catalog_item' AND v.deleted_at IS NULL
          AND f.field_key IN ('material', 'grade') AND v.value_text IS NOT NULL AND v.value_text <> ''
        GROUP BY f.field_key, v.value_text
        ORDER BY f.field_key, n DESC, v.value_text`,
      [companyId],
    ),
  ]);
  const idCounts = (rows) => Object.fromEntries(rows.map((r) => [Number(r.id), Number(r.n)]));
  const valueCounts = (rows) => rows.map((r) => ({ value: String(r.value), n: Number(r.n) }));
  return {
    category: idCounts(cats),
    group: idCounts(grps),
    subgroup: idCounts(subs),
    materialForm: valueCounts(forms),
    material: valueCounts(steel.filter((r) => r.k === 'material')),
    grade: valueCounts(steel.filter((r) => r.k === 'grade')),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Where used — counts plus enough names to recognise them
// ─────────────────────────────────────────────────────────────────────────

/**
 * `itemUsage`'s counts, plus up to `limit` of the BOM parents and orders
 * behind them — a popover can show "used by Girder G1, G2…" without a
 * second endpoint, and the delete dialog keeps reading the same counts.
 */
export async function itemUsageDetail(companyId, catalogItemId, limit = 10) {
  const id = Number(catalogItemId);
  const [counts, [boms], [orders]] = await Promise.all([
    itemUsage(companyId, id),
    pool.query(
      `SELECT DISTINCT p.id AS itemId, p.name, p.code
         FROM fab_item_bom b
         JOIN fab_item_catalog p ON p.id = b.parent_item_id AND p.company_id = b.company_id AND p.deleted_at IS NULL
        WHERE b.company_id = ? AND b.deleted_at IS NULL AND b.child_item_id = ?
        ORDER BY p.name LIMIT ?`,
      [companyId, id, limit],
    ),
    pool.query(
      `SELECT DISTINCT o.id AS orderId, o.order_number AS orderNumber
         FROM fab_items i
         JOIN fab_orders o ON o.id = i.order_id AND o.deleted_at IS NULL
        WHERE i.company_id = ? AND i.deleted_at IS NULL AND i.catalog_item_id = ?
        ORDER BY o.id DESC LIMIT ?`,
      [companyId, id, limit],
    ),
  ]);
  return {
    ...counts,
    boms: boms.map((r) => ({ itemId: Number(r.itemId), name: r.name, code: r.code })),
    orders: orders.map((r) => ({ orderId: Number(r.orderId), orderNumber: r.orderNumber })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Bulk edit
// ─────────────────────────────────────────────────────────────────────────

const PROCUREMENT_TYPES = new Set(['buy', 'make', 'free_issue']);
const MAX_BULK = 1000;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Apply one patch to many items — the taxonomy/procurement columns directly,
 * material/grade through the field store — in one transaction.
 *
 * Taxonomy is validated as a CHAIN: a sub-group must sit under the group, the
 * group under the category, and every node must belong to this company.
 * `fab_item_catalog` has no CHECK for any of that, so this is where it is
 * enforced. A patch naming only a group inherits the group's category; a
 * patch naming only a category drops group and sub-group (they could not
 * belong to it), which is also what the taxonomy picker sends.
 *
 * @returns {Promise<{updated:number, rejected:Array}>}
 */
export async function bulkUpdateCatalogItems(companyId, ids, patch) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))];
  if (!list.length || list.some((n) => !Number.isInteger(n) || n <= 0)) throw badRequest('ids must be a non-empty list of integers.');
  if (list.length > MAX_BULK) throw badRequest(`At most ${MAX_BULK} items per bulk edit.`);
  if (!patch || typeof patch !== 'object') throw badRequest('Missing "patch".');

  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== '';
  const cols = {};
  const fields = {};

  if (has('procurementType')) {
    if (!PROCUREMENT_TYPES.has(patch.procurementType)) throw badRequest(`Unknown procurement type "${patch.procurementType}".`);
    cols.procurement_type = patch.procurementType;
  }
  for (const k of STEEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) fields[k] = patch[k] == null ? null : String(patch[k]).trim();
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const lookup = async (table, id) => {
      const [[row]] = await conn.query(`SELECT * FROM ${table} WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`, [id, companyId]);
      return row ?? null;
    };
    let categoryId = has('categoryId') ? Number(patch.categoryId) : null;
    let groupId = has('groupId') && patch.groupId != null ? Number(patch.groupId) : null;
    const subgroupId = has('subgroupId') && patch.subgroupId != null ? Number(patch.subgroupId) : null;

    if (subgroupId != null) {
      const sg = await lookup('fab_item_subgroups', subgroupId);
      if (!sg) throw badRequest('Sub-group does not belong to this company.');
      if (groupId != null && Number(sg.group_id) !== groupId) throw badRequest('Sub-group does not belong to that group.');
      groupId = Number(sg.group_id);
    }
    if (groupId != null) {
      const g = await lookup('fab_item_groups', groupId);
      if (!g) throw badRequest('Group does not belong to this company.');
      if (categoryId != null && Number(g.category_id) !== categoryId) throw badRequest('Group does not belong to that category.');
      categoryId = Number(g.category_id);
    }
    if (categoryId != null) {
      if (!(await lookup('fab_item_categories', categoryId))) throw badRequest('Category does not belong to this company.');
      cols.category_id = categoryId;
      cols.group_id = groupId;
      cols.subgroup_id = subgroupId;
    }

    if (!Object.keys(cols).length && !Object.keys(fields).length) throw badRequest('Nothing to change.');

    // A non-catalog item is made, never bought — a bulk "Set procurement"
    // must not make a template part or cut plate purchasable.
    if (cols.procurement_type && cols.procurement_type !== 'make') {
      await assertCataloged(conn, companyId, list, `set to "${cols.procurement_type}"`);
    }

    // Only this company's rows — a forged id from another tenant simply
    // doesn't match, and the count says how many really changed.
    const [[{ n: owned }]] = await conn.query(
      'SELECT COUNT(*) AS n FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL AND id IN (?)',
      [companyId, list],
    );
    if (Number(owned) !== list.length) throw badRequest(`${list.length - Number(owned)} of the selected items do not exist in this company.`);

    let updated = 0;
    if (Object.keys(cols).length) {
      const [r] = await conn.query(
        'UPDATE fab_item_catalog SET ? WHERE company_id = ? AND deleted_at IS NULL AND id IN (?)',
        [cols, companyId, list],
      );
      updated = r.affectedRows;
    }

    let rejected = [];
    if (Object.keys(fields).length) {
      const rows = [];
      for (const id of list) for (const [key, value] of Object.entries(fields)) rows.push({ scopeId: id, key, value });
      const result = await setFieldsBulk(companyId, 'catalog_item', rows, conn);
      rejected = result.rejected;
      updated = Math.max(updated, list.length);
    }

    await conn.commit();
    return { updated, rejected };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Inline size edit
// ─────────────────────────────────────────────────────────────────────────

/**
 * Write thickness/width/length on one item. All three are field values;
 * thickness also lands in `fab_item_catalog.thickness_mm` because
 * `fieldProjection` mirrors it there (that column is what the list sorts and
 * range-filters on), so a caller never writes the column itself. The derived
 * weight is recomputed in the same transaction, as `POST /catalog/items` does.
 *
 * @returns {Promise<{sizes:object, unitWeightKg:number|null, rejected:Array}>}
 */
export async function patchCatalogItemSizes(companyId, catalogItemId, sizes) {
  const id = Number(catalogItemId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid item id.');
  const values = {};
  for (const k of SIZE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sizes ?? {}, k)) continue;
    const raw = sizes[k];
    if (raw == null || String(raw).trim() === '') { values[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${k} must be a non-negative number.`);
    values[k] = n;
  }
  if (!Object.keys(values).length) throw badRequest('Nothing to change — send thickness_mm, width_mm and/or length_mm.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT id FROM fab_item_catalog WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, companyId],
    );
    if (!row) throw Object.assign(new Error('Item not found.'), { status: 404 });

    const rows = Object.entries(values).map(([key, value]) => ({ scopeId: id, key, value }));
    const { rejected } = await setFieldsBulk(companyId, 'catalog_item', rows, conn);
    await recomputeCatalogWeight(companyId, [id], conn);

    // Read back what is now stored rather than echoing the input — a
    // rejected value leaves the old one in place, and the grid must show that.
    const [vals] = await conn.query(
      `SELECT f.field_key AS k, v.value_num AS n, v.value_text AS t
         FROM fab_field_values v JOIN fab_fields f ON f.id = v.field_id
        WHERE v.company_id = ? AND v.scope = 'catalog_item' AND v.scope_id = ? AND v.deleted_at IS NULL
          AND f.field_key IN ('thickness_mm','width_mm','length_mm','material','grade','unit_weight_kg')`,
      [companyId, id],
    );
    await conn.commit();
    const byKey = Object.fromEntries(vals.map((r) => [r.k, r.n == null ? r.t : Number(r.n)]));
    return {
      sizes: {
        thicknessMm: byKey.thickness_mm ?? null,
        widthMm: byKey.width_mm ?? null,
        lengthMm: byKey.length_mm ?? null,
        material: byKey.material ?? null,
        grade: byKey.grade ?? null,
      },
      unitWeightKg: byKey.unit_weight_kg != null ? Number(byKey.unit_weight_kg) : null,
      rejected: rejected.map(({ scopeId: _s, ...rest }) => rest),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
