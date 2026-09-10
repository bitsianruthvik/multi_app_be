/**
 * blankPlanService.js — which plate each blank should be cut from.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * `blankService` says WHAT has to be cut: 24 rectangles, so many of each. This
 * says WHERE FROM — for every blank, the plate sizes that could hold it, how
 * many fit on one, how many plates that needs, and how much steel it wastes.
 *
 * It is the data behind the nesting screen: one row per blank, expandable to
 * the alternatives, with the cheapest already chosen.
 *
 * ── IT REUSES THE PACKER'S GEOMETRY, DELIBERATELY ────────────────────────────
 *
 * `capacityOf` from `nestingPacker` answers "how many of this rectangle fit on
 * that plate", and `plateCatalog` from `nestingSuggestService` is the list of
 * plate sizes with their grade and material resolved through the field ladder.
 * Both are used as-is.
 *
 * A grid-fit written here instead would have been ten lines and would have
 * disagreed with the suggestor about what fits — which is the exact failure the
 * codebase has hit before, where two answers to the same question let a Span
 * look like it had no BOM.
 *
 * ── HOW A PLATE IS RANKED ────────────────────────────────────────────────────
 *
 * By STEEL BOUGHT, not by tidiness. A plate that fits the rectangle beautifully
 * but has to be bought in larger sheets loses to an awkward one that buys less
 * mass, because mass is the invoice. Offcuts already on the shelf are ranked
 * ahead of everything: they are paid for, so their marginal cost is zero.
 */

import { pool } from '../../../db.js';
import { plateCatalog, offcutSpecs } from './nestingSuggestService.js';
import { capacityOf, DEFAULT_CUT_GAP_MM } from './nestingPacker.js';
import { orderBlanks } from './blankService.js';

const STEEL_DENSITY = 7850;

/** kg of one plate of this size. */
const plateKg = (p) => (p.thickness * p.width * p.length * STEEL_DENSITY) / 1e9;

/**
 * The plan for an order: every blank, its candidate plates, and what is chosen.
 *
 * @param {object} opts
 * @param {number} [opts.maxAlternatives] how many runners-up to return per blank
 * @returns {Promise<object>}
 */
export async function blankPlan(companyId, orderId, opts = {}) {
  const maxAlternatives = opts.maxAlternatives ?? 6;
  const { orderNumber, blanks, skipped } = await orderBlanks(companyId, orderId);
  if (!blanks.length) {
    return { orderNumber, blanks: [], skipped, summary: emptySummary() };
  }

  const plates = await plateCatalog(companyId);

  /*
   * WHAT THIS ORDER HAS ALREADY DECIDED, so the screen opens on the current
   * plan rather than on a fresh proposal that quietly disagrees with it.
   */
  const [chosenRows] = await pool.query(
    `SELECT i.catalog_item_id AS blankCatalogId, m.catalog_item_id AS plateCatalogId,
            m.qty AS plates, m.nest_no AS nestNo, i.flow_id AS flowId
       FROM fab_items i
       JOIN fab_item_catalog b ON b.id = i.catalog_item_id AND b.material_form = 'blank'
       LEFT JOIN fab_items m ON m.parent_item_id = i.id AND m.node_kind = 'material'
                            AND m.deleted_at IS NULL
      WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        AND i.node_kind = 'structure'`,
    [companyId, orderId],
  );
  /*
   * KEYED BY CODE, NOT BY CATALOG ID.
   *
   * `orderBlanks` computes the rectangles without touching the catalogue, so
   * its rows carry `catalogItemId: null` — only `materialiseBlanks` fills that
   * in. Looking the saved plate up by id therefore matched nothing, and every
   * row fell back to "the best candidate" while claiming to show the plan. The
   * screen would have quietly disagreed with what the order actually says.
   *
   * The code is derived from the blank's identity and is stable, so it is the
   * right key here and does not need a write to exist.
   */
  const [blankItems] = await pool.query(
    `SELECT id, code FROM fab_item_catalog
      WHERE company_id = ? AND material_form = 'blank' AND deleted_at IS NULL
        AND code IN (?)`,
    [companyId, blanks.map((b) => b.code)],
  );
  const catalogIdByCode = new Map(blankItems.map((r) => [String(r.code), Number(r.id)]));
  const chosenBy = new Map(chosenRows.map((r) => [Number(r.blankCatalogId), r]));

  // Offcuts of the right thicknesses only — the yard may hold hundreds, and
  // there is no sense ranking 16 mm drops for a 12 mm rectangle.
  const plateIds = plates.map((p) => p.id);
  let drops = [];
  try {
    drops = await offcutSpecs(companyId, plateIds);
  } catch {
    drops = [];   // offcut tracking is optional; its absence is not an error
  }

  const out = [];
  for (const b of blanks) {
    const row = { length: b.length, width: b.width, qty: b.qty };

    const candidates = [];
    for (const p of [...drops, ...plates]) {
      if (Number(p.thickness) !== Number(b.thickness)) continue;
      // Grade and material must match. A 12 mm E350 rectangle cut from E250 is
      // not a cheaper option, it is the wrong steel.
      if (p.grade && b.grade && String(p.grade) !== String(b.grade)) continue;
      if (p.material && b.material && String(p.material) !== String(b.material)) continue;

      const perPlate = capacityOf(row, p, DEFAULT_CUT_GAP_MM);
      if (!perPlate) continue;

      const isDrop = p.available != null;      // offcutSpecs marks its own
      const available = isDrop ? Number(p.available ?? 1) : Infinity;
      const needed = Math.ceil(b.qty / perPlate);
      const used = Math.min(needed, available);
      const kgEach = plateKg(p);

      candidates.push({
        plateCatalogItemId: p.id,
        code: p.code,
        name: p.name,
        thickness: p.thickness,
        width: p.width,
        length: p.length,
        isDrop,
        perPlate,
        plates: used,
        coversAll: used * perPlate >= b.qty,
        buyKg: isDrop ? 0 : used * kgEach,      // a drop is already paid for
        grossKg: used * kgEach,
        yield: kgEach > 0 ? Math.min(1, (b.qty * b.unitWeightKg) / (needed * kgEach)) : 0,
      });
    }

    /*
     * Cheapest steel first, with a drop always ahead of a bought sheet of the
     * same cost. `coversAll` breaks the tie above both: a plate that cannot
     * hold the whole quantity is a partial answer and belongs below one that can.
     */
    candidates.sort((x, y) => (Number(y.coversAll) - Number(x.coversAll))
      || (x.buyKg - y.buyKg)
      || (Number(y.isDrop) - Number(x.isDrop)));

    const catalogItemId = b.catalogItemId ?? catalogIdByCode.get(b.code) ?? null;
    const current = catalogItemId == null ? undefined : chosenBy.get(Number(catalogItemId));
    const chosenId = current?.plateCatalogId == null ? null : Number(current.plateCatalogId);
    const chosen = chosenId != null
      ? candidates.find((c) => c.plateCatalogItemId === chosenId) ?? null
      : null;

    out.push({
      key: b.key,
      code: b.code,
      name: b.name,
      material: b.material,
      grade: b.grade,
      thickness: b.thickness,
      width: b.width,
      length: b.length,
      qty: b.qty,
      unitWeightKg: b.unitWeightKg,
      totalWeightKg: b.totalWeightKg,
      partNames: b.partNames,
      partCount: b.parts.length,
      catalogItemId,
      nestNo: current?.nestNo ?? null,
      flowId: current?.flowId == null ? null : Number(current.flowId),
      /** What is currently saved, if anything; otherwise the best candidate. */
      chosen: chosen ?? candidates[0] ?? null,
      chosenIsSaved: !!chosen,
      alternatives: candidates.slice(0, maxAlternatives),
      candidateCount: candidates.length,
    });
  }

  return { orderNumber, blanks: out, skipped, summary: summarise(out) };
}

function emptySummary() {
  return { blanks: 0, pieces: 0, plates: 0, boughtKg: 0, usedKg: 0, dropKg: 0, yield: 0, unplaced: 0 };
}

function summarise(rows) {
  let pieces = 0;
  let plates = 0;
  let boughtKg = 0;
  let usedKg = 0;
  let unplaced = 0;
  for (const r of rows) {
    pieces += r.qty;
    usedKg += r.totalWeightKg;
    if (!r.chosen) { unplaced += 1; continue; }
    plates += r.chosen.plates;
    boughtKg += r.chosen.grossKg;
  }
  return {
    blanks: rows.length,
    pieces,
    plates,
    boughtKg,
    usedKg,
    dropKg: Math.max(0, boughtKg - usedKg),
    yield: boughtKg > 0 ? usedKg / boughtKg : 0,
    unplaced,
  };
}
