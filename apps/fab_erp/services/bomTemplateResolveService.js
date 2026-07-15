/**
 * bomTemplateResolveService.js
 * -----------------------------
 * EU-14: Template -> stock resolution service + instantiation hook.
 *
 * Exported function:
 *   resolveTemplate(templateId, projectId, projectItemId, plantId)
 *
 * What it does (single transaction):
 *   1. Loads the fab_bom_template_nodes tree for `templateId` (self-referencing
 *      via parent_node_id, mirroring fab_material_bom_items.parent_bom_item_id
 *      and the existing routes/bom.js `/bom/copy-template` walk).
 *   2. For every 'raw_material' node that has a matching fab_bom_template_slots
 *      row, resolves a concrete fab_item_catalog row per the slot's
 *      selection_strategy (see resolveSlot() below).
 *   3. Re-creates the node tree as fab_items rows for `projectId`
 *      (self-referencing via parent_item_id). Root nodes (parent_node_id IS
 *      NULL) are attached under `projectItemId` if one was given, else they
 *      become project-level roots (parent_item_id = NULL) -- same convention
 *      as routes/bom.js `/bom/copy-template`.
 *   4. Best-effort triggers taskInstanceService.materializeTasks(companyId,
 *      projectId) (EU-5) as an isolated final step -- see the clearly-marked
 *      block near the bottom. A failure there does NOT roll back the fab_items
 *      tree that was already committed; it is logged and surfaced in the
 *      return value so the caller can retry materialization independently
 *      (e.g. via the existing POST /tasks/materialize route).
 *
 * fab_stock_pieces.status: this codebase's actual status literal is
 * 'in_stock' (see fab_stock_pieces.status DEFAULT 'in_stock' in models/init.sql
 * and the literal written by services/grnService.postGrn()). It is a plain
 * VARCHAR(20), not an ENUM, and no other status literal is written anywhere
 * in this codebase today. There is no 'available' value -- resolveSlot()
 * below queries status = 'in_stock'.
 *
 * catalog_category / catalog_group matching: fab_bom_template_slots stores
 * these as free-text VARCHARs (see models/init.sql), not FK ids, so they are
 * resolved to fab_item_categories.id / fab_item_groups.id via a
 * case-insensitive match against `name` (falling back to `code`) before
 * being used to filter fab_item_catalog.category_id / group_id. If a slot's
 * catalog_category/catalog_group text does not match any row, that
 * constraint is simply not applied (treated as "no filter") rather than
 * hard-failing the whole resolution.
 *
 * dimension_params matching: fab_custom_fields (level='stock_piece') holds
 * each physical piece's dimension attributes as free-text field_value. Since
 * there is no fixed schema for dimension_params, matching supports two shapes
 * per key: `{ "<dim>": <number> }` (matched within a default +/-2% tolerance)
 * or `{ "<dim>": { "value": <number>, "tolerance": <number> } }` (matched
 * within an explicit absolute tolerance). Keys not present on a piece's
 * custom fields cause that piece to be excluded from consideration.
 *
 * soonest_available limitation (per task spec): open-GRN-ETA data is not
 * readily queryable in this schema (fab_grns/fab_grn_lines don't carry an
 * "expected date" column distinct from grn_date, which is the date of an
 * already-posted receipt, not a future ETA). soonest_available therefore:
 *   (a) first tries the same available_now matching (in-stock piece exists
 *       now -> use it, same as available_now), and
 *   (b) if no in-stock match exists, falls back to ranking *all* catalog
 *       items that satisfy the category/group/dimension constraints by
 *       fab_item_catalog.lead_time_days ASC (shorter lead time = sooner),
 *       ignoring dimension matching for this fallback tier since no physical
 *       piece exists yet to compare dimensions against -- this is the
 *       best-effort limitation called out in the task spec.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

// ---------------------------------------------------------------------------
// Dimension matching helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOLERANCE_PCT = 0.02; // 2%

function parseDimensionParams(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Returns true if the piece's custom fields (level='stock_piece') satisfy
 * every dimension constraint in dimensionParams.
 * @param {Record<string, any>} dimensionParams
 * @param {Map<string, string>} pieceFieldValues  field_key -> field_value (raw text)
 */
function matchesDimensions(dimensionParams, pieceFieldValues) {
  const keys = Object.keys(dimensionParams || {});
  if (keys.length === 0) return true;

  for (const key of keys) {
    const spec = dimensionParams[key];
    const rawValue = pieceFieldValues.get(key);
    if (rawValue === undefined || rawValue === null || rawValue === '') return false;

    const actual = Number(rawValue);
    if (Number.isNaN(actual)) return false;

    let target;
    let tolerance;
    if (spec !== null && typeof spec === 'object') {
      target = Number(spec.value);
      tolerance = spec.tolerance !== undefined && spec.tolerance !== null
        ? Number(spec.tolerance)
        : Math.abs(target) * DEFAULT_TOLERANCE_PCT;
    } else {
      target = Number(spec);
      tolerance = Math.abs(target) * DEFAULT_TOLERANCE_PCT;
    }

    if (Number.isNaN(target)) return false;
    if (Math.abs(actual - target) > tolerance) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Category / group text -> id resolution
// ---------------------------------------------------------------------------

async function resolveCategoryId(conn, companyId, catalogCategory) {
  if (!catalogCategory) return null;
  const [[row]] = await conn.query(
    `SELECT id FROM fab_item_categories
      WHERE company_id = ? AND deleted_at IS NULL
        AND (LOWER(name) = LOWER(?) OR LOWER(code) = LOWER(?))
      LIMIT 1`,
    [companyId, catalogCategory, catalogCategory],
  );
  return row ? row.id : null;
}

async function resolveGroupId(conn, companyId, catalogGroup, categoryId) {
  if (!catalogGroup) return null;
  const params = [companyId, catalogGroup, catalogGroup];
  let sql = `SELECT id FROM fab_item_groups
              WHERE company_id = ? AND deleted_at IS NULL
                AND (LOWER(name) = LOWER(?) OR LOWER(code) = LOWER(?))`;
  if (categoryId != null) {
    sql += ` AND category_id = ?`;
    params.push(categoryId);
  }
  sql += ` LIMIT 1`;
  const [[row]] = await conn.query(sql, params);
  return row ? row.id : null;
}

/**
 * Candidate fab_item_catalog rows for a slot's category/group text filter.
 * Returns [{ id, lead_time_days }].
 */
async function candidateCatalogItems(conn, companyId, categoryId, groupId) {
  const where = ['fic.company_id = ?', 'fic.deleted_at IS NULL'];
  const params = [companyId];
  if (categoryId != null) {
    where.push('fic.category_id = ?');
    params.push(categoryId);
  }
  if (groupId != null) {
    where.push('fic.group_id = ?');
    params.push(groupId);
  }
  const [rows] = await conn.query(
    `SELECT fic.id, fic.lead_time_days
       FROM fab_item_catalog fic
      WHERE ${where.join(' AND ')}`,
    params,
  );
  return rows;
}

/**
 * In-stock pieces (status = 'in_stock') at plantId for a set of candidate
 * catalog item ids, matching the slot's dimension_params, ordered by
 * received_date ASC (earliest received first).
 */
async function findAvailablePiece(conn, companyId, plantId, catalogItemIds, dimensionParams) {
  if (catalogItemIds.length === 0) return null;

  const [pieces] = await conn.query(
    `SELECT id, catalog_item_id, received_date
       FROM fab_stock_pieces
      WHERE company_id = ? AND plant_id = ? AND status = 'in_stock'
        AND deleted_at IS NULL
        AND catalog_item_id IN (?)
      ORDER BY received_date ASC, id ASC`,
    [companyId, plantId, catalogItemIds],
  );

  if (pieces.length === 0) return null;

  const dimKeys = Object.keys(dimensionParams || {});
  if (dimKeys.length === 0) {
    // No dimension constraints -- first (earliest received) piece wins.
    return pieces[0];
  }

  const pieceIds = pieces.map((p) => p.id);
  const [cfRows] = await conn.query(
    `SELECT level_id, field_key, field_value
       FROM fab_custom_fields
      WHERE company_id = ? AND level = 'stock_piece' AND deleted_at IS NULL
        AND level_id IN (?)`,
    [companyId, pieceIds],
  );

  const fieldsByPiece = new Map(); // piece id -> Map(field_key -> field_value)
  for (const cf of cfRows) {
    if (!fieldsByPiece.has(cf.level_id)) fieldsByPiece.set(cf.level_id, new Map());
    fieldsByPiece.get(cf.level_id).set(cf.field_key, cf.field_value);
  }

  for (const piece of pieces) {
    const pieceFields = fieldsByPiece.get(piece.id) ?? new Map();
    if (matchesDimensions(dimensionParams, pieceFields)) return piece;
  }

  return null;
}

/**
 * Resolves one fab_bom_template_slots row to a concrete fab_item_catalog id
 * (or null, e.g. unresolved 'manual' slot).
 */
async function resolveSlot(conn, companyId, plantId, slot) {
  const dimensionParams = parseDimensionParams(slot.dimension_params);

  if (slot.selection_strategy === 'manual') {
    return slot.default_catalog_item_id ?? null;
  }

  const categoryId = await resolveCategoryId(conn, companyId, slot.catalog_category);
  const groupId = await resolveGroupId(conn, companyId, slot.catalog_group, categoryId);
  const candidates = await candidateCatalogItems(conn, companyId, categoryId, groupId);
  const candidateIds = candidates.map((c) => c.id);

  // available_now (and the first tier of soonest_available): earliest
  // received in-stock piece matching category/group + dimensions.
  const piece = await findAvailablePiece(conn, companyId, plantId, candidateIds, dimensionParams);
  if (piece) return piece.catalog_item_id;

  if (slot.selection_strategy === 'available_now') {
    // No in-stock match -- available_now has nothing further to fall back to.
    return null;
  }

  // soonest_available fallback tier: no physical piece in stock yet, so
  // dimension matching can't be applied (no piece to compare against). Rank
  // remaining candidates by lead_time_days ASC (shorter = sooner). This is
  // the best-effort limitation noted in the task spec -- open-GRN ETA data
  // isn't readily queryable in this schema (fab_grn_lines has no distinct
  // "expected date" column; grn_date is the date of an already-posted
  // receipt, not a future ETA).
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aLt = Number(a.lead_time_days) || Infinity;
    const bLt = Number(b.lead_time_days) || Infinity;
    return aLt - bLt;
  });

  return candidates[0].id;
}

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

/**
 * @param {number} templateId
 * @param {number} projectId
 * @param {number|null} projectItemId  fab_items.id under which the template's
 *   root node(s) should be attached (parent_item_id). If null/undefined, root
 *   nodes become top-level project items (parent_item_id = NULL), matching
 *   the existing routes/bom.js `/bom/copy-template` convention.
 * @param {number} plantId  plant to resolve 'available_now'/'soonest_available'
 *   stock against.
 * @returns {Promise<{ ok: boolean, itemsCreated: number, slotsResolved: number,
 *   slotsUnresolved: number, rootItemIds: number[],
 *   taskMaterialization: { attempted: boolean, ok?: boolean, error?: string, result?: object } }>}
 */
export async function resolveTemplate(templateId, projectId, projectItemId, plantId) {
  const conn = await pool.getConnection();
  let companyId;

  try {
    await conn.beginTransaction();

    // ── 0. Resolve companyId from the order (all fab_erp tables are
    //    company-scoped; the caller doesn't pass companyId explicitly per
    //    the task's function signature, so we derive it here). fab_projects
    //    was dropped and fab_items now scopes to fab_orders directly. ─────
    const [[order]] = await conn.query(
      `SELECT company_id FROM fab_orders WHERE id = ? AND deleted_at IS NULL`,
      [projectId],
    );
    if (!order) {
      throw new Error(`fab_orders ${projectId} not found`);
    }
    companyId = order.company_id;

    const [[template]] = await conn.query(
      `SELECT id FROM fab_bom_templates
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [templateId, companyId],
    );
    if (!template) {
      throw new Error(`fab_bom_templates ${templateId} not found for company ${companyId}`);
    }

    // ── 1. Load the node tree ────────────────────────────────────────────
    const [nodes] = await conn.query(
      `SELECT id, parent_node_id, node_role, ref_catalog_item_id, qty, unit, sort_order
         FROM fab_bom_template_nodes
        WHERE template_id = ? AND company_id = ? AND deleted_at IS NULL
        ORDER BY parent_node_id IS NULL DESC, sort_order ASC, id ASC`,
      [templateId, companyId],
    );

    if (nodes.length === 0) {
      await conn.commit();
      return {
        ok: true,
        itemsCreated: 0,
        slotsResolved: 0,
        slotsUnresolved: 0,
        rootItemIds: [],
        taskMaterialization: { attempted: false },
      };
    }

    // ── 2. Load slots for raw_material nodes, keyed by node_id ──────────
    const [slots] = await conn.query(
      `SELECT id, node_id, slot_key, param_label, catalog_category, catalog_group,
              dimension_params, selection_strategy, default_catalog_item_id
         FROM fab_bom_template_slots
        WHERE template_id = ? AND company_id = ? AND deleted_at IS NULL`,
      [templateId, companyId],
    );
    const slotByNodeId = new Map(slots.map((s) => [s.node_id, s]));

    // ── 3. Resolve every slot up front ───────────────────────────────────
    let slotsResolved = 0;
    let slotsUnresolved = 0;
    const resolvedCatalogItemIdByNodeId = new Map();

    for (const node of nodes) {
      if (node.node_role !== 'raw_material') continue;
      const slot = slotByNodeId.get(node.id);
      if (!slot) continue; // raw_material node with a fixed ref_catalog_item_id, no slot

      const resolvedId = await resolveSlot(conn, companyId, plantId, slot);
      resolvedCatalogItemIdByNodeId.set(node.id, resolvedId);
      if (resolvedId != null) slotsResolved++;
      else slotsUnresolved++;
    }

    // ── 4. Bulk-fetch catalog names for fixed + resolved catalog item ids
    //    (fab_items.name is NOT NULL, so every created row needs a name) ──
    const catalogItemIdsNeeded = new Set();
    for (const node of nodes) {
      if (node.ref_catalog_item_id != null) catalogItemIdsNeeded.add(node.ref_catalog_item_id);
    }
    for (const id of resolvedCatalogItemIdByNodeId.values()) {
      if (id != null) catalogItemIdsNeeded.add(id);
    }
    let catalogNameById = new Map();
    if (catalogItemIdsNeeded.size > 0) {
      const [catRows] = await conn.query(
        `SELECT id, name FROM fab_item_catalog WHERE company_id = ? AND id IN (?)`,
        [companyId, [...catalogItemIdsNeeded]],
      );
      catalogNameById = new Map(catRows.map((r) => [r.id, r.name]));
    }

    // ── 5. Walk the tree and create fab_items rows ───────────────────────
    const byParent = new Map();
    for (const node of nodes) {
      const key = node.parent_node_id ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(node);
    }

    let itemsCreated = 0;
    const rootItemIds = [];

    async function insertNode(node, parentItemId) {
      let catalogItemId = node.ref_catalog_item_id ?? null;
      const slot = slotByNodeId.get(node.id);

      if (node.node_role === 'raw_material' && slot) {
        catalogItemId = resolvedCatalogItemIdByNodeId.has(node.id)
          ? resolvedCatalogItemIdByNodeId.get(node.id)
          : null;
      }

      const name =
        (catalogItemId != null ? catalogNameById.get(catalogItemId) : null) ??
        slot?.param_label ??
        slot?.slot_key ??
        (node.node_role === 'raw_material' ? 'Raw Material (unresolved)' : node.node_role);

      const [result] = await conn.query(
        `INSERT INTO fab_items (company_id, order_id, parent_item_id, catalog_item_id, name, unit, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [companyId, projectId, parentItemId, catalogItemId, name, node.unit, node.qty],
      );
      itemsCreated++;
      const newId = result.insertId;

      if (parentItemId === null && node.parent_node_id === null) {
        rootItemIds.push(newId);
      }

      for (const child of byParent.get(node.id) ?? []) {
        await insertNode(child, newId);
      }
    }

    const roots = byParent.get(null) ?? [];
    const rootParentItemId = projectItemId ?? null;
    for (const root of roots) {
      await insertNode(root, rootParentItemId);
    }
    // If roots were attached under an existing projectItemId, report that as
    // the anchor rather than leaving rootItemIds empty.
    if (rootParentItemId !== null && rootItemIds.length === 0) {
      rootItemIds.push(rootParentItemId);
    }

    await conn.commit();

    // ── 6. Optional, isolated step: EU-5 task materialization ───────────
    // Deliberately OUTSIDE the fab_items transaction above and wrapped in
    // its own try/catch: a failure here must not roll back (or block) the
    // fab_items tree that was already committed. taskInstanceService.js
    // (EU-5) exists in this codebase as of this writing
    // (services/taskInstanceService.js, materializeTasks(companyId, projectId)),
    // but this call stays defensive (dynamic import + try/catch) in case
    // that changes in a future refactor / EU-5 is reverted.
    let taskMaterialization = { attempted: false };
    try {
      const { materializeTasks } = await import('./taskInstanceService.js');
      const result = await materializeTasks(companyId, projectId);
      taskMaterialization = { attempted: true, ok: true, result };
    } catch (err) {
      logger.error(
        { err, companyId, projectId },
        '[bomTemplateResolveService] EU-5 materializeTasks step failed (non-fatal, fab_items tree already committed)',
      );
      taskMaterialization = { attempted: true, ok: false, error: err.message };
    }

    return {
      ok: true,
      itemsCreated,
      slotsResolved,
      slotsUnresolved,
      rootItemIds,
      taskMaterialization,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
