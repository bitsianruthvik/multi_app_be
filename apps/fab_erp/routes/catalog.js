/**
 * catalog.js — EU-15: one transaction for creating a catalog item, one
 * authority for deleting taxonomy, and a server-side catalog list.
 *
 * NEW FILE, not folded into `routes/items.js`/`routes/index.js` — both are
 * being edited concurrently by another unit of work; this prefix-sharing
 * pattern (a fresh router mounted alongside the others in `app.js`) already
 * exists for the planner/procurement/actuals routers.
 *
 *   GET    /catalog/items              — server-side list, sizes + derived weight inline; size-aware `q`
 *   GET    /catalog/items/facets       — item counts per category/group/sub-group/form/material/grade
 *   POST   /catalog/items              — create an item AND its field values, one transaction
 *   POST   /catalog/items/bulk         — one patch (taxonomy/procurement/material/grade) over many items
 *   PATCH  /catalog/items/:id/fields   — inline thickness/width/length edit from the grid
 *   GET    /catalog/items/:id/usage    — how many BOMs/orders reference it, and up to 10 of each by name
 *   DELETE /taxonomy/:level/:id        — refuses (409 + count) if any item still references it
 *   GET    /orders/:id/lines           — a line's row, built-count and spec, batched for every line
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm, fail } from '../../../core/middleware/requirePerm.js';
import { pool } from '../../../db.js';
import { generateCode, orderRowCodeRanges, orderCodePrefix } from '../services/codegenService.js';
import { setFieldsBulk, resolveFields } from '../services/fieldService.js';
import { recomputeCatalogWeight } from '../services/fieldDeriveService.js';
import { catalogSizes, sellableItems } from '../services/catalogPickerService.js';
import {
  parseCatalogSearch, searchClauses, textFieldClause, catalogFacets, itemUsageDetail,
  bulkUpdateCatalogItems, patchCatalogItemSizes,
} from '../services/catalogItemsService.js';

const router = Router();
const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

/**
 * Friendly 409 on the taxonomy's own case-insensitive uniqueness (§13) —
 * same parsing mutateController uses, duplicated rather than imported since
 * that copy is private to the controller and this route needs the identical
 * behaviour for the ONE insert it does outside the generic `/mutate` path.
 */
function duplicateKeyMessage(err) {
  const indexName = String(err.sqlMessage ?? '').match(/for key '[^']*\.([^']+)'/)?.[1] ?? '';
  if (/code_active|_code\b/i.test(indexName)) return 'A record with this code already exists.';
  if (/name_active/i.test(indexName)) return 'A record with this name already exists.';
  return 'A record with this name or code already exists.';
}

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog/items — server-side list (S5)
// ─────────────────────────────────────────────────────────────────────────

/** Columns a caller may sort by — never interpolate the query string itself. */
const SORT_COLUMNS = {
  name: 'fic.name',
  code: 'fic.code',
  unit: 'fic.unit',
  procurementType: 'fic.procurement_type',
  materialForm: 'fic.material_form',
  categoryName: 'fic_cat.name',
  groupName: 'fig_grp.name',
  createdAt: 'fic.created_at',
  // The one size dimension that is a real, indexed column. Width/length live
  // in fab_field_values (per-item, not every item has one) — sorting on those
  // across a whole page would need a join with no supporting index, so this
  // is thickness-only; ties keep insertion order. Noted as a limitation
  // rather than silently pretending it is a full 3-key sort.
  size: 'fic.thickness_mm',
  thicknessMm: 'fic.thickness_mm',
};

router.get('/catalog/items', protect, async (req, res) => {
  const cid = companyId(req);
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const where = ['fic.company_id = ?', 'fic.deleted_at IS NULL'];
    const params = [cid];
    // Size-aware: "25x1500", "E350 12mm" and the like become dimension/grade
    // matches on the field store, and only the leftover words hit name/code.
    // Grammar in `catalogItemsService.parseCatalogSearch`.
    if (req.query.q) {
      const parsed = parseCatalogSearch(String(req.query.q));
      const clauses = await searchClauses(cid, parsed, 'fic');
      where.push(...clauses.where);
      params.push(...clauses.params);
    }
    // Material / grade are field values, not columns — exact match on the
    // text the facets endpoint handed out, so a dropdown pick always hits.
    for (const key of ['material', 'grade']) {
      if (req.query[key] !== undefined && req.query[key] !== '') {
        const c = await textFieldClause(cid, key, String(req.query[key]), 'fic');
        where.push(c.where);
        params.push(...c.params);
      }
    }
    if (req.query.procurementType) {
      where.push('fic.procurement_type = ?');
      params.push(String(req.query.procurementType));
    }
    if (req.query.materialForm) {
      where.push('fic.material_form = ?');
      params.push(String(req.query.materialForm));
    }
    if (req.query.thicknessMin !== undefined && req.query.thicknessMin !== '') {
      where.push('fic.thickness_mm >= ?');
      params.push(Number(req.query.thicknessMin));
    }
    if (req.query.thicknessMax !== undefined && req.query.thicknessMax !== '') {
      where.push('fic.thickness_mm <= ?');
      params.push(Number(req.query.thicknessMax));
    }
    // Taxonomy filters (REPAIR-B item 1) — ANDed with everything else so a
    // caller can combine e.g. categoryId + q. `uncategorized=1` is its own
    // filter (NULL category_id) rather than categoryId=0/'' since 0 is not a
    // valid id and the page needs to express "no category" explicitly.
    for (const [param, col] of [
      ['categoryId', 'fic.category_id'],
      ['groupId', 'fic.group_id'],
      ['subgroupId', 'fic.subgroup_id'],
    ]) {
      if (req.query[param] !== undefined && req.query[param] !== '') {
        const n = Number(req.query[param]);
        if (!Number.isInteger(n)) {
          return res.status(400).json({ error: 'BAD_REQUEST', message: `${param} must be an integer` });
        }
        where.push(`${col} = ?`);
        params.push(n);
      }
    }
    if (String(req.query.uncategorized) === '1') {
      where.push('fic.category_id IS NULL');
    }
    const whereSql = where.join(' AND ');

    // A real COUNT(*) over the same WHERE — §13 "Getting a row count from the
    // query API — pass includeTotal" is about the generic query engine; this
    // is hand-written SQL, so the equivalent is just asking directly rather
    // than inferring a total from one page's `data.length`.
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM fab_item_catalog fic WHERE ${whereSql}`,
      params,
    );

    const sortCol = SORT_COLUMNS[req.query.sort] ?? SORT_COLUMNS.name;
    const dir = String(req.query.dir ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // resourceDef.json's `fabErpItemCatalog.category` relation also names
    // `fic_cat.batch_required/serial_required/heat_required/mark_required` —
    // `DESCRIBE fab_item_catalog`/`fab_item_categories` locally shows none of
    // those four columns exist (§13 "fab_item_catalog Has No Verified Base
    // DDL"). Left out here rather than guessed at; the generic query engine
    // would hit the same ER_BAD_FIELD_ERROR if a caller ever asked it for them.
    const [rows] = await pool.query(
      `SELECT fic.id, fic.name, fic.code, fic.short_code AS shortCode, fic.unit, fic.description,
              fic.category_id AS categoryId, fic.group_id AS groupId, fic.subgroup_id AS subgroupId,
              fic.hsn_code AS hsnCode, fic.procurement_type AS procurementType,
              fic.lead_time_days AS leadTimeDays, fic.mrp_policy AS mrpPolicy,
              fic.thickness_mm AS thicknessMm, fic.material_form AS materialForm,
              fic.density_kg_m3 AS densityKgM3, fic.section_area_mm2 AS sectionAreaMm2,
              fic.created_at AS createdAt, fic.updated_at AS updatedAt,
              fic_cat.name AS categoryName, fic_cat.code AS categoryCode,
              fig_grp.name AS groupName, fisg_sub.name AS subgroupName
         FROM fab_item_catalog fic
         LEFT JOIN fab_item_categories fic_cat
           ON fic_cat.id = fic.category_id AND fic_cat.company_id = fic.company_id AND fic_cat.deleted_at IS NULL
         LEFT JOIN fab_item_groups fig_grp
           ON fig_grp.id = fic.group_id AND fig_grp.company_id = fic.company_id AND fig_grp.deleted_at IS NULL
         LEFT JOIN fab_item_subgroups fisg_sub
           ON fisg_sub.id = fic.subgroup_id AND fisg_sub.company_id = fic.company_id AND fisg_sub.deleted_at IS NULL
        WHERE ${whereSql}
        ORDER BY ${sortCol} ${dir}, fic.id ASC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );

    const ids = rows.map((r) => Number(r.id));
    // Sizes (thickness/width/length/material/grade off the field store) AND
    // the derived weight (item 7), both inline — replacing the per-item
    // `/catalog/sizes` round trip the FE made for every row on the page.
    const [sizes, weights] = await Promise.all([
      catalogSizes(cid, ids),
      ids.length
        ? resolveFields(cid, ids.map((id) => ({ scope: 'catalog_item', scopeId: id })))
        : new Map(),
    ]);

    const out = rows.map((r) => {
      const s = sizes.get(Number(r.id)) ?? {};
      const weight = weights.get(`catalog_item:${r.id}`)?.unit_weight_kg?.value;
      return {
        ...r,
        sizes: {
          thicknessMm: s.thickness_mm ?? (r.thicknessMm != null ? Number(r.thicknessMm) : null),
          widthMm: s.width_mm ?? null,
          lengthMm: s.length_mm ?? null,
          material: s.material ?? null,
          grade: s.grade ?? null,
        },
        unitWeightKg: weight != null ? Number(weight) : null,
      };
    });

    res.json({ rows: out, total: Number(total), page, pageSize });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog/items/facets — counts behind every filter option
// ─────────────────────────────────────────────────────────────────────────

router.get('/catalog/items/facets', protect, async (req, res) => {
  try {
    return res.json(await catalogFacets(companyId(req)));
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /catalog/items/bulk { ids, patch } — one patch over many rows
// ─────────────────────────────────────────────────────────────────────────

// Registered before any `/catalog/items/:id/...` route so "bulk" can never be
// read as an id — Express matches in registration order.
router.post('/catalog/items/bulk', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
  try {
    const { ids, patch } = req.body ?? {};
    const result = await bulkUpdateCatalogItems(companyId(req), ids, patch);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /catalog/items { item, fields } — one transaction (item 4)
// ─────────────────────────────────────────────────────────────────────────

router.post('/catalog/items', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
  const cid = companyId(req);
  const { item, fields } = req.body ?? {};
  if (!item || typeof item !== 'object') {
    return res.status(400).json({ message: 'Missing "item".' });
  }
  if (!item.name || !String(item.name).trim()) {
    return res.status(400).json({ message: 'Item name is required.' });
  }
  if (!item.categoryId) {
    return res.status(400).json({ message: 'Category is required.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // A category/group/subgroup id from outside this company must never be
    // accepted — the taxonomy pickers in the UI are company-scoped, but
    // nothing on the wire otherwise stops a stale or forged id belonging to
    // a different tenant landing on this row.
    for (const [field, table, label] of [
      ['categoryId', 'fab_item_categories', 'Category'],
      ['groupId', 'fab_item_groups', 'Group'],
      ['subgroupId', 'fab_item_subgroups', 'Subgroup'],
    ]) {
      const val = item[field];
      if (val == null || val === '') continue;
      const [[row]] = await conn.query(
        `SELECT id FROM ${table} WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [val, cid],
      );
      if (!row) {
        await conn.rollback();
        return res.status(400).json({ message: `${label} does not belong to this company.` });
      }
    }

    // `ifBlank` — the same policy `mutateController`'s AUTOGEN_CODE_RESOURCES
    // gives `fabErpItemCatalog`: a typed code wins, a blank one is generated
    // from the category. Done here directly (not by round-tripping through
    // `/mutate`) because this route owns the whole insert as one transaction.
    let code = item.code ? String(item.code).trim().toUpperCase() : '';
    if (!code) {
      code = (await generateCode(cid, 'item', { categoryId: item.categoryId }, conn)).toUpperCase();
    }

    const row = {
      company_id: cid,
      name: String(item.name).trim(),
      code,
      // The segment an ORDER ROW of this item carries in its code (parent code
      // + short code + position). Blank = the initials of the name, derived
      // at code time (codegenService.shortName), so nothing is stored for it.
      short_code: item.shortCode ? String(item.shortCode).trim().toUpperCase().slice(0, 12) || null : null,
      unit: item.unit ? String(item.unit).trim() : 'pcs',
      description: item.description ? String(item.description).trim() : null,
      category_id: item.categoryId,
      group_id: item.groupId ?? null,
      subgroup_id: item.subgroupId ?? null,
      hsn_code: item.hsnCode ? String(item.hsnCode).trim() : null,
      procurement_type: item.procurementType || 'buy',
      mrp_policy: item.mrpPolicy || 'manual',
      lead_time_days: item.leadTimeDays ?? null,
    };
    // Real columns, only written when stated — a NULL thickness/material_form
    // is "not a specifically-sized item", not zero.
    if (item.thicknessMm != null && item.thicknessMm !== '') row.thickness_mm = Number(item.thicknessMm);
    if (item.materialForm) row.material_form = item.materialForm;

    const [insertRes] = await conn.query('INSERT INTO fab_item_catalog SET ?', [row]);
    const itemId = insertRes.insertId;

    let rejected = [];
    if (fields && Object.keys(fields).length) {
      const fieldRows = Object.entries(fields).map(([key, value]) => ({ scopeId: itemId, key, value }));
      const result = await setFieldsBulk(cid, 'catalog_item', fieldRows, conn);
      rejected = result.rejected;
    }

    // Item 7 — a specifically-sized item (thickness/width/length + density)
    // gets its weight the moment it exists, not on the next unrelated write.
    await recomputeCatalogWeight(cid, [itemId], conn);

    await conn.commit();
    return res.status(201).json({ ok: true, id: itemId, code, rejected });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return res.status(409).json({ message: duplicateKeyMessage(err) });
    }
    return fail(res, err);
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog/items/:id/usage
// ─────────────────────────────────────────────────────────────────────────

router.get('/catalog/items/:id/usage', protect, async (req, res) => {
  try {
    const usage = await itemUsageDetail(companyId(req), Number(req.params.id));
    return res.json(usage);
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /catalog/items/:id/fields { thickness_mm?, width_mm?, length_mm? }
// ─────────────────────────────────────────────────────────────────────────

router.patch('/catalog/items/:id/fields', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
  try {
    const result = await patchCatalogItemSizes(companyId(req), Number(req.params.id), req.body ?? {});
    return res.json({ ok: true, ...result });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /taxonomy/:level/:id — one authority, not a client-side cascade
// ─────────────────────────────────────────────────────────────────────────

const TAXONOMY_TABLES = {
  category: 'fab_item_categories',
  group: 'fab_item_groups',
  subgroup: 'fab_item_subgroups',
};

router.delete(
  '/taxonomy/:level/:id',
  protect,
  requirePerm('fab_erp_items_meta_manage'),
  async (req, res) => {
    const cid = companyId(req);
    const { level } = req.params;
    const id = Number(req.params.id);
    const table = TAXONOMY_TABLES[level];
    if (!table || !Number.isFinite(id)) {
      return res.status(400).json({ message: `Unknown taxonomy level "${level}".` });
    }

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Every id AT OR BELOW this node — this table has no FK, so the DELETE
        // guard here is the only thing standing between a delete and orphaning
        // whatever still points at it (§13 "Most Core Tables ... but Several
        // Common Ones Don't"). Read on the SAME connection/transaction as the
        // cascade below (not a separate pool query before it), so the in-use
        // check and the actual delete see one consistent snapshot instead of
        // leaving a gap where a catalog item could be inserted against this
        // node between "not in use" and the delete landing.
        let groupIds = [];
        let subgroupIds = [];
        if (level === 'category') {
          const [groups] = await conn.query(
            'SELECT id FROM fab_item_groups WHERE company_id = ? AND category_id = ? AND deleted_at IS NULL',
            [cid, id],
          );
          groupIds = groups.map((g) => Number(g.id));
          if (groupIds.length) {
            const [subs] = await conn.query(
              'SELECT id FROM fab_item_subgroups WHERE company_id = ? AND group_id IN (?) AND deleted_at IS NULL',
              [cid, groupIds],
            );
            subgroupIds = subs.map((s) => Number(s.id));
          }
        } else if (level === 'group') {
          const [subs] = await conn.query(
            'SELECT id FROM fab_item_subgroups WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL',
            [cid, id],
          );
          subgroupIds = subs.map((s) => Number(s.id));
        }

        const categoryMatch = level === 'category' ? [id] : [];
        const groupMatch = level === 'group' ? [id] : groupIds;
        const subgroupMatch = level === 'subgroup' ? [id] : subgroupIds;

        // Matched independently on all three columns — a data-consistency
        // safety net, not just a shortcut off category_id: `fab_item_catalog`
        // has no CHECK that group_id/subgroup_id actually descend from the
        // row's own category_id.
        const clauses = [];
        const countParams = [cid];
        if (categoryMatch.length) { clauses.push('category_id IN (?)'); countParams.push(categoryMatch); }
        if (groupMatch.length) { clauses.push('group_id IN (?)'); countParams.push(groupMatch); }
        if (subgroupMatch.length) { clauses.push('subgroup_id IN (?)'); countParams.push(subgroupMatch); }

        if (clauses.length) {
          const [[{ n }]] = await conn.query(
            `SELECT COUNT(*) AS n FROM fab_item_catalog
              WHERE company_id = ? AND deleted_at IS NULL AND (${clauses.join(' OR ')})`,
            countParams,
          );
          if (Number(n) > 0) {
            await conn.rollback();
            return res.status(409).json({
              code: 'TAXONOMY_IN_USE',
              count: Number(n),
              message: `${n} catalog item${Number(n) === 1 ? '' : 's'} still reference this ${level}.`,
            });
          }
        }

        if (level !== 'subgroup' && subgroupMatch.length) {
          await conn.query(
            'UPDATE fab_item_subgroups SET deleted_at = UTC_TIMESTAMP() WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
            [cid, subgroupMatch],
          );
        }
        if (level === 'category' && groupMatch.length) {
          await conn.query(
            'UPDATE fab_item_groups SET deleted_at = UTC_TIMESTAMP() WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL',
            [cid, groupMatch],
          );
        }
        const [result] = await conn.query(
          `UPDATE \`${table}\` SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
          [id, cid],
        );
        if (!result.affectedRows) {
          await conn.rollback();
          return res.status(404).json({ message: 'Not found.' });
        }
        await conn.commit();
        return res.json({
          ok: true, id, level,
          cascaded: { groups: level === 'category' ? groupMatch.length : 0, subgroups: subgroupMatch.length },
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      return fail(res, err);
    }
  },
);

/**
 * GET /catalog/sellable-items?q= — what an order LINE may sell (item 8).
 * Read-only reference data for a picker, gated on `protect` alone, matching
 * `/catalog/pickable` in templates.js.
 */
router.get('/catalog/sellable-items', protect, async (req, res) => {
  try {
    const items = await sellableItems(companyId(req), { search: req.query.q || null });
    return res.json({ items });
  } catch (err) {
    return fail(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /orders/:id/lines — rows + built counts + spec, in one round trip
// ─────────────────────────────────────────────────────────────────────────

router.get('/orders/:id/lines', protect, async (req, res) => {
  const cid = companyId(req);
  const orderId = Number(req.params.id);
  if (!Number.isFinite(orderId)) return res.status(400).json({ message: 'Invalid order id.' });

  try {
    const [[order]] = await pool.query(
      'SELECT id FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1',
      [orderId, cid],
    );
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    const [lines] = await pool.query(
      `SELECT id, line_no AS lineNo, code, description, qty, unit_price AS unitPrice,
              catalog_item_id AS catalogItemId, template_item_id AS templateItemId, line_type AS lineType
         FROM fab_order_lines
        WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
        ORDER BY line_no`,
      [cid, orderId],
    );
    if (!lines.length) return res.json({ rows: [] });

    const lineIds = lines.map((l) => Number(l.id));
    const catalogIds = [...new Set(lines.map((l) => l.catalogItemId).filter(Boolean))];

    const [catalogRows, builtRows, specRows] = await Promise.all([
      catalogIds.length
        ? pool.query(
          `SELECT c.id, c.name, c.code,
                  cat.name AS categoryName, g.name AS groupName, sg.name AS subgroupName
             FROM fab_item_catalog c
             LEFT JOIN fab_item_categories cat ON cat.id = c.category_id
             LEFT JOIN fab_item_groups g ON g.id = c.group_id
             LEFT JOIN fab_item_subgroups sg ON sg.id = c.subgroup_id
            WHERE c.company_id = ? AND c.id IN (?)`,
          [cid, catalogIds],
        ).then(([r]) => r)
        : [],
      pool.query(
        `SELECT order_line_id AS lineId, COUNT(*) AS n FROM fab_items
          WHERE company_id = ? AND order_line_id IN (?) AND node_kind = 'structure' AND deleted_at IS NULL
          GROUP BY order_line_id`,
        [cid, lineIds],
      ).then(([r]) => r),
      // The line's OWN stated material/grade/thickness — same shape as
      // `getItemSpecHandler('lines')` (orderItemsImportController.js), batched
      // across every line on the order instead of one request per line.
      pool.query(
        `SELECT v.scope_id AS lineId, d.field_key AS k, v.value_text AS t, v.value_num AS n
           FROM fab_field_values v
           JOIN fab_fields d ON d.id = v.field_id AND d.deleted_at IS NULL
          WHERE v.company_id = ? AND v.scope = 'order_line' AND v.scope_id IN (?) AND v.deleted_at IS NULL
            AND d.field_key IN ('material', 'grade', 'thickness_mm')`,
        [cid, lineIds],
      ).then(([r]) => r),
    ]);

    const catalogById = new Map(catalogRows.map((c) => [Number(c.id), c]));
    const builtByLine = new Map(builtRows.map((r) => [Number(r.lineId), Number(r.n)]));

    /*
     * THE LINE'S ROW CODE — the top row of its structure (SPAN1), written at
     * deploy or previewed from the same rule before that. The screen shows
     * this, not the catalog item's code: it names THIS span on THIS order.
     */
    const [roots] = await pool.query(
      `SELECT id, order_line_id AS lineId, code FROM fab_items
        WHERE company_id = ? AND order_id = ? AND parent_item_id IS NULL
          AND node_kind = 'structure' AND deleted_at IS NULL`,
      [cid, orderId],
    );
    // Always computed: a line of qty 5 reads SPAN1…5 even once SPAN1 is written.
    const ranges = roots.length ? await orderRowCodeRanges(cid, orderId) : new Map();
    const rootCodeByLine = new Map();
    const rootCodeLastByLine = new Map();
    for (const r of roots) {
      if (r.lineId == null || rootCodeByLine.has(Number(r.lineId))) continue;
      rootCodeByLine.set(Number(r.lineId), r.code ?? ranges.get(Number(r.id))?.code ?? null);
      rootCodeLastByLine.set(Number(r.lineId), ranges.get(Number(r.id))?.last ?? null);
    }
    const codePrefix = roots.length ? `${await orderCodePrefix(cid, orderId)}-` : null;
    const specByLine = new Map();
    for (const r of specRows) {
      const e = specByLine.get(Number(r.lineId)) ?? { material: null, grade: null, thickness_mm: null };
      e[r.k] = r.n == null ? r.t : Number(r.n);
      specByLine.set(Number(r.lineId), e);
    }

    const rows = lines.map((l) => {
      const cat = l.catalogItemId ? catalogById.get(Number(l.catalogItemId)) ?? null : null;
      const spec = specByLine.get(Number(l.id)) ?? { material: null, grade: null, thickness_mm: null };
      return {
        ...l,
        catalogItem: cat ? {
          id: Number(cat.id), name: cat.name, code: cat.code,
          categoryName: cat.categoryName, groupName: cat.groupName, subgroupName: cat.subgroupName,
        } : null,
        builtCount: builtByLine.get(Number(l.id)) ?? 0,
        rootCode: rootCodeByLine.get(Number(l.id)) ?? null,
        rootCodeLast: rootCodeLastByLine.get(Number(l.id)) ?? null,
        material: spec.material,
        grade: spec.grade,
        thicknessMm: spec.thickness_mm,
      };
    });

    return res.json({ rows, codePrefix });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
