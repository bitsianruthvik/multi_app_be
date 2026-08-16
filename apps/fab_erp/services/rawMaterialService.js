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
import { pickList } from './itemScopeService.js';

/**
 * Categories that are bought but are NOT stock a part is cut from.
 *
 * `procurement_type = 'buy'` is the right rule for "did we buy this", and it is
 * still the rule below. It is the wrong rule on its own for "what is this part
 * cut from", because a real catalog also contains welding flux, zinc primer,
 * CO2 cylinders and M24 bolts — all genuinely bought, none of them something a
 * flange is cut from. Production had 48 bought items of which 14 were these,
 * so every material picker in the app offered paint alongside plate.
 *
 * This is two named SYSTEM categories excluded, not a category-based
 * definition. The original rule rejected "is it in the Raw Materials category"
 * as an INCLUSION test, and rightly — that category is a filing decision and a
 * part is never cut from a finished good whatever anybody filed it under.
 * Consumables and fasteners are different: they are seeded system rows whose
 * meaning is fixed, and nothing in either is ever cut into anything.
 */
const NOT_CUT_FROM = ['cons', 'fast'];

/**
 * Every raw material a company can cut from, richest form.
 *
 * @param {object} [conn] run inside a caller's transaction
 */
export async function rawMaterialsFor(companyId, conn) {
  const exec = conn ?? pool;

  /**
   * The SCOPE first — an inclusion over the taxonomy (Phase 7).
   *
   * The subtraction below is kept only as a fallback for a company with no
   * scope configured, and it is actively wrong the moment a category is added:
   * Phase 8 put ten machine types into the catalog as `procurement_type='buy'`,
   * and because the rule only knows to exclude consumables and fasteners, this
   * function immediately began offering "CNC Plate Cutting" and "Crane / EOT
   * Crane" as things to cut a flange from. Nothing had changed here — that is
   * what makes subtraction the wrong shape.
   *
   * The scope's shortcoming is the opposite and safer one: a category nobody
   * has included is absent, and an absence is visible in a way a wrong presence
   * is not.
   */
  try {
    const { scope, items } = await pickList(companyId, 'bom_material', { conn: exec });
    if (scope && items.length) {
      return items.map((i) => ({
        id: i.id, code: i.code, name: i.name, unit: i.unit,
        density_kg_m3: i.densityKgM3 ?? null, section_area_mm2: i.sectionAreaMm2 ?? null,
        thickness_mm: i.thicknessMm ?? null, material_form: i.materialForm ?? null,
        category_code: i.categoryCode ?? null,
      })).sort((a, b) =>
        String(a.material_form ?? '').localeCompare(String(b.material_form ?? ''))
        || (Number(a.thickness_mm ?? 0) - Number(b.thickness_mm ?? 0))
        || String(a.code).localeCompare(String(b.code)));
    }
  } catch {
    // A scope that cannot be read must not take the material picker down with
    // it; the legacy rule below still answers.
  }

  const [rows] = await exec.query(
    `SELECT fic.id, fic.code, fic.name, fic.unit, fic.density_kg_m3, fic.section_area_mm2,
            fic.thickness_mm, fic.material_form
       FROM fab_item_catalog fic
       LEFT JOIN fab_item_categories cat
         ON cat.id = fic.category_id AND cat.deleted_at IS NULL
      WHERE fic.company_id = ? AND fic.deleted_at IS NULL
        AND fic.procurement_type = 'buy'
        AND COALESCE(cat.code, '') NOT IN (${NOT_CUT_FROM.map(() => '?').join(',')})
      ORDER BY fic.material_form, fic.thickness_mm, fic.code`,
    [companyId, ...NOT_CUT_FROM],
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
 *   no thickness recorded      ONLY when nothing matches exactly. "Not knowing a
 *                              thickness is not the same as knowing it is wrong"
 *                              is true, and it justifies offering these when
 *                              there is nothing better — not when there is. With
 *                              an exact match on the shelf, a plate whose
 *                              thickness nobody filled in is the worse answer,
 *                              and including it unconditionally put the same
 *                              handful of untyped rows in every part's list at
 *                              every thickness, which is how a thickness filter
 *                              stops meaning anything. They stay reachable: with
 *                              no exact match this falls back to them exactly as
 *                              before.
 *
 * A blank or unusable thickness returns everything: with nothing to filter on,
 * offering the lot beats offering none.
 *
 * Mirrored in the frontend's api/rawMaterials.ts — separate repos, so the rule
 * is stated once on each side and must be changed on both.
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
  /**
   * EXACT MATCHES ONLY — plate and section alike.
   *
   * This lagged the frontend by a week. `api/rawMaterials.ts` was changed on
   * 2026-08-16 to filter sections by thickness and to stop offering untyped
   * stock, on the evidence that sections DO carry `thicknessMm` (an
   * ISA 100x100x10 records 10, its leg thickness) — so the reasoning that they
   * "can never be reached by a thickness filter" was wrong for the real
   * catalog. This copy was not changed with it, exactly as the comment above
   * warns, so the BOQ sheet's named ranges kept offering every section at every
   * thickness while the screen showed only the right ones.
   *
   * Untyped stock is likewise dropped while filtering: a catalog row whose
   * thickness nobody filled in is not evidence of a match. It stays reachable
   * by clearing the thickness, which returns everything.
   */
  const exact = (m) => m.thickness_mm != null && Number(m.thickness_mm) === t;
  const plates = materials.filter((m) => m.material_form !== 'section' && exact(m));
  const sections = materials.filter((m) => m.material_form === 'section' && exact(m));
  return [...plates, ...sections];
}

/** The distinct plate thicknesses stocked, ascending — what a picker groups by. */
export function stockedThicknesses(materials) {
  const set = new Set();
  for (const m of materials) {
    if (m.material_form !== 'section' && m.thickness_mm != null) set.add(Number(m.thickness_mm));
  }
  return [...set].sort((a, b) => a - b);
}
