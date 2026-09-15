/**
 * itemGuards.js — small facts about a catalog item or item row, asked
 * repeatedly across bomService's writers and the bulk importers.
 *
 * `MRP_POLICIES` and `SOURCE_LABEL`, also named in PLAN.md EU-3 for this file,
 * do not exist anywhere in this codebase today (grepped `services/`,
 * `controllers/`, `routes/`) — there is nothing to hoist. Left out rather than
 * invented; noted in the EU-3 report as a deviation.
 */

/**
 * `make`, `buy`, or `free_issue`, canonical order.
 *
 * `procurementService.js` already exported this; `itemsImportService.js` had
 * its own copy with the SAME two values in the OPPOSITE order (`['buy','make']`
 * vs `['make','buy']`). That order is user-visible — it is the option order in
 * the import template's dropdown — so repointing `itemsImportService.js` at
 * this one changes that dropdown from Buy/Make to Make/Buy. Values unchanged.
 *
 * `free_issue` (EU-14): material the CUSTOMER supplies, not the shop. It is a
 * third answer to "does the shop buy this or make it" — neither, somebody else
 * already has — appended rather than replacing `buy` so nothing that already
 * reads 'buy' as "bought stock" needs to change.
 */
export const PROCUREMENT_TYPES = ['make', 'buy', 'free_issue'];

/**
 * Every catalog item's unit and make/buy flag, in two maps keyed by id.
 *
 * `buildFromTree` and `applyTree` each ran this exact query (same columns,
 * same WHERE) to answer "what unit does this catalog item use" and "is this
 * row made or bought" while walking a tree. One query, one pair of maps.
 *
 * @returns {Promise<{unitOf: Map<number,string>, procurementOf: Map<number,string>}>}
 */
export async function catalogKinds(conn, companyId) {
  const [rows] = await conn.query(
    `SELECT id, unit, procurement_type FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  return {
    unitOf: new Map(rows.map((k) => [Number(k.id), k.unit])),
    procurementOf: new Map(rows.map((k) => [Number(k.id), k.procurement_type])),
  };
}

/**
 * Refuse when any of `itemIds` carries shop-floor history — a task that has
 * started or finished. Replacing/removing the row would throw that away.
 *
 * Merged from three copies in `bomService.js` (`buildFromTree`'s replace guard,
 * `applyTree`'s removed-row guard) that differed only in which item ids they
 * had already computed. `e.code` is kept alongside the new `e.detail` because
 * `templates.js`'s 409 handler already surfaces `code` to the caller.
 *
 * @param {number[]} itemIds
 */
export async function assertNoStartedWork(conn, companyId, itemIds) {
  const ids = (itemIds ?? []).filter(Boolean);
  if (!ids.length) return;
  const [[worked]] = await conn.query(
    `SELECT COUNT(*) AS n FROM fab_project_tasks
      WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL
        AND (started_at IS NOT NULL OR status IN ('in_progress','paused','done'))`,
    [companyId, ids],
  );
  if (worked.n > 0) {
    const e = new Error(
      `Refused: ${worked.n} task(s) on the affected row(s) have already been started or finished. `
      + 'This would throw that shop-floor history away.',
    );
    e.status = 409;
    e.code = 'WORK_STARTED';
    e.detail = { startedItemIds: ids };
    throw e;
  }
}

/**
 * A short, stable code from a free-text name — `"Deck Plate 10mm"` ->
 * `"DECK_PLATE_10MM"`. Identical in `itemsImportService.js`,
 * `operationsImportService.js` and `resourcesImportService.js`; only
 * `itemsImportService.js` is repointed here (the other two are outside this
 * EU's file list).
 */
export function autoCode(name, maxLen = 20) {
  const c = (name || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return c || 'CODE';
}
