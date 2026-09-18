/**
 * catalogKind.js — cataloged vs non-catalog items, decided in ONE place.
 *
 * ── THE RULE (product owner, 2026-09-18) ─────────────────────────────────────
 *
 *   CATALOGED   a standing definition you pick, buy, receive or stock across
 *               orders: plates, sections, studs, standard stiffeners, machines,
 *               spares, consumables. Precise — exact size, exact BOM or none.
 *   NON-CATALOG either ABSTRACT (a template part — Top Flange, Segment, Span —
 *               that only gets its size on an order) or DISPOSABLE (a cut plate
 *               made for one order). Never bought, never received by hand.
 *               Non-catalog stock exists, but only the shop MAKES it (WIP,
 *               finished parts, cut plates) — see wipInventoryService.
 *
 * Both live in `fab_item_catalog` — order rows, pieces, codes, fields and marks
 * all point at these ids, and none of those tables has a foreign key to the
 * catalog, so moving rows out would orphan ids silently.
 *
 * ── WHY PER ITEM, NOT PER CATEGORY ───────────────────────────────────────────
 *
 * Cut plates share the Raw Materials category with real plates, and a standard
 * assembly with an exact BOM may sit beside template parts. So the flag is on
 * the item (`is_cataloged`), stamped at insert from the category's
 * `default_cataloged`, and forced to 0 for a blank (`material_form = 'blank'`).
 *
 * `material_form = 'blank'` stays THE test for "is this a cut plate" — it is
 * not replaced by this flag, which is also 0 for templates. See blankPredicate.
 *
 * ── HOW IT IS ENFORCED ───────────────────────────────────────────────────────
 *
 * Every path that buys, receives, reserves or links stock by hand calls
 * `assertCataloged`. It throws a 422 naming the items, so a refusal says WHAT
 * was refused rather than "failed".
 */

/** SQL: this catalog alias is a cataloged item. */
export const CATALOGED = (alias = 'c') => `${alias}.is_cataloged = 1`;

/**
 * The three lists the Item Catalog page shows (Catalog tab; Non-catalog tab
 * split into its two sections). A cut plate is told apart from a template part
 * by `material_form`, the same test blankPredicate uses — never by this flag
 * alone, which is 0 for both.
 */
export const ITEM_KINDS = ['catalog', 'template', 'cutplate'];

/** SQL condition for one list, or null for "everything" (no kind asked). */
export function kindWhere(kind, alias = 'fic') {
  if (kind == null || kind === '') return null;
  switch (kind) {
    case 'catalog': return `${alias}.is_cataloged = 1`;
    case 'template': return `(${alias}.is_cataloged = 0 AND COALESCE(${alias}.material_form, '') <> 'blank')`;
    case 'cutplate': return `${alias}.material_form = 'blank'`;
    default: {
      const err = new Error(`Unknown kind "${kind}". Use one of: ${ITEM_KINDS.join(', ')}.`);
      err.status = 400;
      throw err;
    }
  }
}

function notCataloged(names, action) {
  const list = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  const err = new Error(
    `${list} ${names.length === 1 ? 'is' : 'are'} not a catalog item, so it cannot be ${action}. ` +
    'Template parts and cut plates are made by the shop on an order, never bought or received.',
  );
  err.code = 'NOT_CATALOGED';
  err.status = 422;
  return err;
}

/**
 * Refuse any non-catalog item among `ids`.
 *
 * Ids that do not exist in the company are left to the caller's own "not
 * found" handling — this answers one question only.
 *
 * @param {object} exec a pool or a connection (run inside the caller's txn)
 * @param {number} companyId
 * @param {Array<number|string|null>} ids
 * @param {string} action what was being attempted, e.g. 'received into stock'
 */
export async function assertCataloged(exec, companyId, ids, action) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return;
  const [rows] = await exec.query(
    `SELECT name FROM fab_item_catalog
      WHERE company_id = ? AND id IN (?) AND is_cataloged = 0`,
    [companyId, list],
  );
  if (rows.length) throw notCataloged(rows.map((r) => r.name), action);
}

/**
 * The flag a NEW item gets.
 *
 * A cut plate is always non-catalog. Otherwise an explicit choice wins, and
 * with none the category decides (`default_cataloged`, 1 when unset or when
 * the item has no category).
 *
 * @returns {Promise<0|1>}
 */
export async function catalogedForNew(exec, companyId, { categoryId = null, materialForm = null, explicit } = {}) {
  if (materialForm === 'blank') return 0;
  if (explicit === true || explicit === 1 || explicit === '1') return 1;
  if (explicit === false || explicit === 0 || explicit === '0') return 0;
  if (!categoryId) return 1;
  const [[cat]] = await exec.query(
    `SELECT default_cataloged FROM fab_item_categories WHERE id = ? AND company_id = ? LIMIT 1`,
    [categoryId, companyId],
  );
  return cat && Number(cat.default_cataloged) === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// PICK LINES — a template line that stands for ANY catalog item in a filter
// ─────────────────────────────────────────────────────────────────────────────
//
// "Intermediate stiffener: any item in Standard Parts › Plate Stiffeners." The
// line's child stays a template PART (the role: its name, code segment and
// flow); the filter says which catalog items may fill it, and the sales order
// picks exactly one. Stored on fab_item_bom as pick_category_id /
// pick_group_id / pick_subgroup_id (+ an optional pick_default_item_id).

/** A line's filter off a row carrying the pick columns, or null when it is not a pick line. */
export function pickOf(row) {
  const cat = row?.pickCategoryId ?? row?.pick_category_id ?? null;
  if (cat == null) return null;
  return {
    categoryId: Number(cat),
    groupId: (row.pickGroupId ?? row.pick_group_id) != null ? Number(row.pickGroupId ?? row.pick_group_id) : null,
    subgroupId: (row.pickSubgroupId ?? row.pick_subgroup_id) != null ? Number(row.pickSubgroupId ?? row.pick_subgroup_id) : null,
    defaultItemId: (row.pickDefaultItemId ?? row.pick_default_item_id) != null
      ? Number(row.pickDefaultItemId ?? row.pick_default_item_id) : null,
  };
}

/** SQL + params: catalog items inside a pick filter. Always catalog items only. */
export function pickWhere(pick, alias = 'c') {
  const where = [`${alias}.is_cataloged = 1`, `${alias}.deleted_at IS NULL`, `${alias}.category_id = ?`];
  const params = [pick.categoryId];
  if (pick.groupId != null) { where.push(`${alias}.group_id = ?`); params.push(pick.groupId); }
  if (pick.subgroupId != null) { where.push(`${alias}.subgroup_id = ?`); params.push(pick.subgroupId); }
  return { where: where.join(' AND '), params };
}

/**
 * Check a filter names real, consistent taxonomy of this company: the group
 * inside the category, the sub-group inside the group. A filter that quietly
 * matches nothing is the failure this refuses.
 */
export async function assertPickFilter(exec, companyId, pick) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; e.code = 'BAD_PICK_FILTER'; return e; };
  if (!pick || pick.categoryId == null) throw bad('A pick line needs at least a category to pick from.');
  const [[cat]] = await exec.query(
    'SELECT id FROM fab_item_categories WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    [pick.categoryId, companyId],
  );
  if (!cat) throw bad('That category does not exist in this company.');
  if (pick.groupId != null) {
    const [[g]] = await exec.query(
      'SELECT category_id FROM fab_item_groups WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
      [pick.groupId, companyId],
    );
    if (!g || Number(g.category_id) !== Number(pick.categoryId)) throw bad('That group is not inside the chosen category.');
  }
  if (pick.subgroupId != null) {
    if (pick.groupId == null) throw bad('A sub-group needs its group chosen too.');
    const [[s]] = await exec.query(
      'SELECT group_id FROM fab_item_subgroups WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
      [pick.subgroupId, companyId],
    );
    if (!s || Number(s.group_id) !== Number(pick.groupId)) throw bad('That sub-group is not inside the chosen group.');
  }
  if (pick.defaultItemId != null) await assertInPick(exec, companyId, pick, [pick.defaultItemId], 'the default');
}

/**
 * Refuse any item that is not a catalog item inside `pick`. What stops an
 * import, a /mutate write or a stale screen from putting a machine — or a
 * template part — where a stiffener was asked for.
 */
export async function assertInPick(exec, companyId, pick, itemIds, what = 'the chosen item') {
  const ids = [...new Set((itemIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  const { where, params } = pickWhere(pick, 'c');
  const [rows] = await exec.query(
    `SELECT c.id FROM fab_item_catalog c WHERE c.company_id = ? AND c.id IN (?) AND ${where}`,
    [companyId, ids, ...params],
  );
  const ok = new Set(rows.map((r) => Number(r.id)));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length) {
    const [named] = await exec.query('SELECT name FROM fab_item_catalog WHERE id IN (?)', [missing]);
    const e = new Error(
      `${named.map((n) => n.name).join(', ') || `Item #${missing[0]}`} is not one of the catalog items this line picks from, so it cannot be ${what}.`,
    );
    e.status = 422;
    e.code = 'PICK_OUT_OF_FILTER';
    throw e;
  }
}

/** Catalog items a pick line may be filled with, for a picker. */
export async function pickCandidates(exec, companyId, pick, { search = null, limit = 200 } = {}) {
  const { where, params } = pickWhere(pick, 'c');
  const [rows] = await exec.query(
    `SELECT c.id, c.code, c.name, c.unit, c.thickness_mm AS thicknessMm, c.procurement_type AS procurementType
       FROM fab_item_catalog c
      WHERE c.company_id = ? AND ${where}
        ${search ? 'AND (c.name LIKE ? OR c.code LIKE ?)' : ''}
      ORDER BY c.thickness_mm, c.name
      LIMIT ?`,
    [companyId, ...params, ...(search ? [`%${search}%`, `%${search}%`] : []), limit],
  );
  return rows;
}

/**
 * A non-catalog item is never bought: it is made on an order. Anything else is
 * how a template quietly became buyable and lost its production code (the
 * create route and the importer both defaulted to 'buy').
 */
export function procurementFor(isCataloged, requested) {
  if (!Number(isCataloged)) return 'make';
  return requested || 'buy';
}
