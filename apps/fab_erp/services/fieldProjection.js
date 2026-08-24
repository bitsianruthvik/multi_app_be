/**
 * fieldProjection.js — the legacy columns, kept as a DERIVED copy.
 *
 * Step 4 of FAB_ERP_FIELDS_REDESIGN.md, done in the order that is safe rather
 * than the order that is tidy.
 *
 * THE PROBLEM. Thirteen keys exist as both a field and a column. The columns
 * survive because they are matched in SQL: procurement and consumption filter
 * `fab_stock_pieces.length_mm`, the nesting board reads `fab_items.height AS
 * partThick`, weights read `fab_item_catalog.density_kg_m3`. Those are the
 * queries that stop the wrong steel being cut, and rewriting all four in one
 * change is not a thing to do on a Tuesday.
 *
 * THE ORDER THAT IS SAFE. Make the VALUE the system of record first, and keep
 * the column as a projection written from it. Then:
 *
 *   - there is one place a dimension is authored, so drift is impossible
 *   - every matcher keeps working, untouched and indexed
 *   - the matchers move one at a time afterwards, each verifiable on its own
 *   - dropping the column is last, and by then it reads nothing
 *
 * This is NOT "columns stay the system of record" — the decision was values,
 * and this honours it. The column stops being somewhere you write and becomes
 * somewhere the value is copied to, which is a cache, not a second truth.
 *
 * `height` IS THICKNESS. `fab_items.height` holds the BOQ sheet's Thick column
 * — the sheet declares it with key `height` — so it projects from
 * `thickness_mm`, not from any height. Anything that "corrects" this mapping
 * silently destroys every thickness in the system.
 */

/**
 * Which field maps to which column, per scope.
 *
 * Only these thirteen. A field with no entry is values-only already and needs
 * no projection; adding one here would be inventing a column.
 */
export const PROJECTIONS = {
  catalog_item: {
    table: 'fab_item_catalog',
    columns: {
      thickness_mm: 'thickness_mm',
      density_kg_m3: 'density_kg_m3',
      section_area_mm2: 'section_area_mm2',
      /**
       * `material_form` joins the projection (2026-08-21) because it was the
       * clearest case of the problem this file exists to solve: a field
       * definition holding ZERO values beside a column holding 1,420, with every
       * reader on the column. A defined field that nothing writes is worse than
       * no field — the next person sets it, nothing happens, and the reason is
       * invisible.
       *
       * It stays a column as well as a field for the same reason the others do:
       * `rawMaterialService` and its frontend mirror filter on it in SQL to
       * split plate from section, and that filter should stay indexed rather
       * than become a join.
       */
      material_form: 'material_form',
    },
  },
  order_item: {
    table: 'fab_items',
    columns: {
      length_mm: 'length',
      width_mm: 'width',
      thickness_mm: 'height', // thickness. See the header.
    },
  },
  stock_piece: {
    table: 'fab_stock_pieces',
    columns: {
      length_mm: 'length_mm',
      width_mm: 'width_mm',
    },
  },
};

/**
 * Copy whichever of these values have a column into that column.
 *
 * Called by `setFields` after it writes, on the same connection, so the value
 * and its projection land together or not at all. A projection that could lag
 * its value by even one failed statement would reintroduce exactly the drift
 * this removes.
 *
 * @param {object} conn  REQUIRED — the writer's transaction
 * @param {Record<string, number|string|null>} written  fieldKey -> value, null to clear
 * @returns {Promise<number>} columns updated
 */
export async function projectToColumns(conn, companyId, scope, scopeId, written) {
  const spec = PROJECTIONS[scope];
  if (!spec || !written || !Object.keys(written).length) return 0;

  const sets = [];
  const params = [];
  for (const [fieldKey, column] of Object.entries(spec.columns)) {
    if (!(fieldKey in written)) continue;
    sets.push(`\`${column}\` = ?`);
    params.push(written[fieldKey]);
  }
  if (!sets.length) return 0;

  await conn.query(
    `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
    [...params, scopeId, companyId],
  );
  return sets.length;
}

/** Does this scope/key pair have a column behind it? */
export const hasProjection = (scope, fieldKey) =>
  Boolean(PROJECTIONS[scope]?.columns?.[fieldKey]);
