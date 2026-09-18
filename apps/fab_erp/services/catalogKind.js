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

/**
 * A non-catalog item is never bought: it is made on an order. Anything else is
 * how a template quietly became buyable and lost its production code (the
 * create route and the importer both defaulted to 'buy').
 */
export function procurementFor(isCataloged, requested) {
  if (!Number(isCataloged)) return 'make';
  return requested || 'buy';
}
