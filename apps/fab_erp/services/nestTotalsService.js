/**
 * nestTotalsService.js — how much steel a nesting actually consumes.
 *
 * THE ONE PLACE TO ASK, because the raw rows cannot be summed.
 *
 * A shared plate is stored as one material row PER PART, each carrying the
 * plate's full dimensions. That is right for the board — opening a part should
 * show the sheet it comes off — but it means a naive
 * `SUM(total_weight) WHERE node_kind = 'material'` returns 3,857 t for an order
 * whose steel is 669 t. Six times over, because the KEPL nesting puts an average
 * of 8.3 parts on a plate and one 16 mm sheet carries 41.
 *
 * `procurementService` already knows this and special-cases `nest_no` when it
 * sums. Nothing else did, and the next person to write that query has no way of
 * knowing — the rows look like independent plates. So the correct aggregate
 * lives here, once, and anything reporting steel reads it rather than inventing
 * the deduplication again.
 *
 * A NEST IS ONE PLATE. Its area, weight and cost count once no matter how many
 * parts sit on it; the parts divide it, they do not multiply it.
 */

import { pool } from '../../../db.js';

/**
 * Per-nest truth for one order: the plate, how many parts share it, and how
 * much of it they actually use.
 *
 * @returns {Promise<{nests:Array, totals:object}>}
 */
export async function nestTotals(companyId, orderId, conn = null) {
  const exec = conn ?? pool;

  /*
   * Grouped by nest, so each plate contributes its area ONCE. The part area is
   * summed across the rows on it — that is the only figure the per-part rows
   * are good for.
   */
  const [rows] = await exec.query(
    `SELECT rm.nest_no AS nestNo,
            MAX(rm.catalog_item_id) AS catalogItemId,
            MAX(c.name)   AS plateName,
            MAX(c.code)   AS plateCode,
            MAX(rm.length) AS plateLength,
            MAX(rm.width)  AS plateWidth,
            MAX(rm.height) AS thickness,
            COUNT(*)       AS parts,
            SUM(COALESCE(p.length, 0) * COALESCE(p.width, 0) * COALESCE(p.qty, 1)) AS partAreaMm2
       FROM fab_items rm
       JOIN fab_items p ON p.id = rm.parent_item_id AND p.deleted_at IS NULL
       LEFT JOIN fab_item_catalog c ON c.id = rm.catalog_item_id AND c.deleted_at IS NULL
      WHERE rm.company_id = ? AND rm.order_id = ? AND rm.deleted_at IS NULL
        AND rm.node_kind = 'material' AND rm.nest_no IS NOT NULL
      GROUP BY rm.nest_no
      ORDER BY rm.nest_no`,
    [companyId, orderId],
  );

  const DENSITY = 7.85e-6; // kg per mm^3, i.e. 7850 kg/m^3

  const nests = rows.map((r) => {
    const plateArea = Number(r.plateLength || 0) * Number(r.plateWidth || 0);
    const partArea = Number(r.partAreaMm2 || 0);
    const t = Number(r.thickness || 0);
    return {
      nestNo: r.nestNo,
      plateCode: r.plateCode,
      plateName: r.plateName,
      thickness: t,
      parts: Number(r.parts),
      // Reads "shares this plate with 5 others" on a part, which is the thing
      // the per-part rows fail to say.
      shared: Number(r.parts) > 1,
      plateAreaMm2: plateArea,
      partAreaMm2: partArea,
      wasteAreaMm2: Math.max(0, plateArea - partArea),
      utilisationPct: plateArea ? Math.round((partArea / plateArea) * 1000) / 10 : 0,
      plateWeightKg: Math.round(plateArea * t * DENSITY * 100) / 100,
    };
  });

  const plateArea = nests.reduce((a, n) => a + n.plateAreaMm2, 0);
  const partArea = nests.reduce((a, n) => a + n.partAreaMm2, 0);
  const steelKg = nests.reduce((a, n) => a + n.plateWeightKg, 0);

  return {
    nests,
    totals: {
      plates: nests.length,
      parts: nests.reduce((a, n) => a + n.parts, 0),
      plateAreaM2: Math.round(plateArea / 1e6 * 100) / 100,
      partAreaM2: Math.round(partArea / 1e6 * 100) / 100,
      wasteAreaM2: Math.round((plateArea - partArea) / 1e6 * 100) / 100,
      utilisationPct: plateArea ? Math.round((partArea / plateArea) * 1000) / 10 : 0,
      // What the order actually buys, counted once per plate. This is the
      // number a naive sum over material rows gets wrong.
      steelTonnes: Math.round(steelKg / 1000 * 100) / 100,
    },
  };
}
