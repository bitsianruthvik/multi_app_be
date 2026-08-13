/**
 * rawMaterialService.js — one definition of "what a part can be cut from".
 *
 * The rule is `procurement_type = 'buy'`: things the shop BUYS, as opposed to
 * things it makes. It is not an item group and not a category, which is worth
 * saying plainly because "raw material" is also the name of a category and the
 * two are unrelated — a part is never cut from a finished good, whatever
 * category anybody filed it under.
 *
 * It used to be spelled out in five places — three backend queries and two
 * frontend filters — which is five chances for them to drift, and no single
 * place to change the rule when it turns out to need changing.
 *
 * THE THICKNESS FILTER LIVES HERE TOO, for the same reason. Which materials a
 * 20mm part may be cut from is a domain rule, not a rendering detail, and it
 * was previously implemented three times over: once in the spreadsheet's named
 * ranges and twice in React. They agreed only by coincidence.
 */

import { pool } from '../../../db.js';

/**
 * Every raw material a company can cut from, richest form.
 *
 * @param {object} [conn] run inside a caller's transaction
 */
export async function rawMaterialsFor(companyId, conn) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT id, code, name, unit, density_kg_m3, section_area_mm2,
            thickness_mm, material_form
       FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND procurement_type = 'buy'
      ORDER BY material_form, thickness_mm, code`,
    [companyId],
  );
  return rows;
}

/**
 * Of those, the ones a part of this thickness could actually be made from.
 *
 * Three groups, each for its own reason:
 *
 *   plates of that thickness   the actual match
 *   sections                   ALWAYS — an angle is one item, and a 100x100x10
 *                              is not "a 10mm thing", so it can never be reached
 *                              by a thickness filter; omitting it would make it
 *                              unpickable rather than merely unmatched
 *   no thickness recorded      ALSO always. The filter exists to exclude what we
 *                              KNOW is the wrong thickness, and not knowing is
 *                              not the same as knowing it is wrong. Excluding
 *                              these made stocked items silently unpickable
 *                              while the reference sheet still listed them.
 *
 * A blank or unusable thickness returns everything: with nothing to filter on,
 * offering the lot beats offering none.
 *
 * @param {Array} materials from rawMaterialsFor
 * @param {number|string|null} thickness
 */
export function materialsForThickness(materials, thickness) {
  const t = Number(thickness);
  if (thickness === null || thickness === undefined || String(thickness).trim() === ''
      || !Number.isFinite(t)) {
    return materials;
  }
  const sections = materials.filter((m) => m.material_form === 'section');
  const plates = materials.filter(
    (m) => m.material_form !== 'section' && m.thickness_mm != null && Number(m.thickness_mm) === t,
  );
  const unclassified = materials.filter(
    (m) => m.material_form !== 'section' && m.thickness_mm == null,
  );
  return [...plates, ...unclassified, ...sections];
}

/** The distinct plate thicknesses stocked, ascending — what a picker groups by. */
export function stockedThicknesses(materials) {
  const set = new Set();
  for (const m of materials) {
    if (m.material_form !== 'section' && m.thickness_mm != null) set.add(Number(m.thickness_mm));
  }
  return [...set].sort((a, b) => a - b);
}
