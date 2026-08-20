/**
 * 01-fields.mjs — the field registry. THIS RUNS FIRST, AND IT HAS TO.
 *
 * Every operation formula in module 04 reads its inputs by `field_key`. The
 * formula engine resolves an unknown key to nothing and carries on, so a
 * missing definition does not fail — it plans a zero-minute task. That is the
 * failure mode this module exists to prevent, and it is why nothing else in the
 * rebuild may run before it.
 *
 * WHY THESE HAVE TO BE CREATED AT ALL. init.sql seeds `fab_fields` from
 * `fab_field_defs`, which was itself seeded from `fab_item_metric_defs` — a
 * table dropped in an earlier phase. What survives that chain in a fresh
 * company is partial and mislabelled: on the local tenant eleven of the twelve
 * keys existed with the WRONG label, and `num_holes` had no unit and no
 * dimension at all, which is a formula input that cannot be converted or
 * validated. `edge_length_m` did not exist. So this is an upsert, not an
 * insert: it repairs what is there and adds what is not.
 *
 * DIMENSION IS DERIVED, NEVER TYPED. `fab_units` is the one table that knows a
 * millimetre is a length and kg/m3 is a rate. Hardcoding the string here would
 * let a field claim a dimension its unit does not have, which is exactly the
 * class of bug `fab_units.factor_to_base` was added to close. A unit that is
 * missing from `fab_units` therefore THROWS rather than inserting NULL — a NULL
 * dimension is a field whose values can never be converted, and it would sit
 * there looking fine.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: `category_id` / `group_id` /
 * `subgroup_id`, the columns that decide where a field is OFFERED. New rows get
 * NULL (offered everywhere) because the plan's table says nothing about
 * scoping, and a field offered too widely is merely noisy while one scoped
 * wrongly is invisible. Existing rows keep whatever scoping they already have.
 */

export const NAME = 'Fields';

/**
 * The twelve, in the order the registry screen should list them.
 *
 * The plan's heading says thirteen; the thirteenth row in the old tenant was
 * `prodqa_coating_thickness`, a non-standard test artefact, and it is not
 * recreated. See the report note.
 *
 * `applies_at` is the NARROWEST rung a value may be authored on. length/width
 * genuinely vary per physical plate, so they are stock_piece; everything else
 * is a property of the part, not of the piece it was cut from.
 */
const FIELDS = [
  { key: 'length_mm',        label: 'Cut length',      unit: 'mm',    appliesAt: 'stock_piece' },
  { key: 'width_mm',         label: 'Cut width',       unit: 'mm',    appliesAt: 'stock_piece' },
  { key: 'thickness_mm',     label: 'Plate thickness', unit: 'mm',    appliesAt: 'order_item' },
  { key: 'unit_weight_kg',   label: 'Unit weight',     unit: 'kg',    appliesAt: 'order_item' },
  { key: 'surface_area_m2',  label: 'Coated surface',  unit: 'm2',    appliesAt: 'order_item' },
  { key: 'weld_length_m',    label: 'Weld run',        unit: 'm',     appliesAt: 'order_item' },
  { key: 'edge_length_m',    label: 'Edge to prepare', unit: 'm',     appliesAt: 'order_item' },
  { key: 'num_holes',        label: 'Holes to drill',  unit: 'nos',   appliesAt: 'order_item' },
  { key: 'density_kg_m3',    label: 'Density',         unit: 'kg/m3', appliesAt: 'order_item' },
  { key: 'section_area_mm2', label: 'Section area',    unit: 'mm2',   appliesAt: 'order_item' },
  { key: 'max_thickness_mm', label: 'Max thickness',   unit: 'mm',    appliesAt: 'order_item' },
  { key: 'power_kw',         label: 'Power',           unit: 'kW',    appliesAt: 'order_item' },
];

/** Columns this module owns. Anything not here is left exactly as found. */
const MANAGED = ['label', 'data_type', 'dimension', 'default_unit', 'applies_at',
  'formula_usable', 'is_standard', 'active'];

/** Loose equality that treats 1 / '1' / true alike, and NULL / undefined alike. */
const same = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
};

export async function seed(ctx) {
  const { companyId, apply, conn, log } = ctx;

  // The dimension source of truth. Read once; it is global, not per company.
  const [unitRows] = await conn.query('SELECT code, dimension FROM fab_units');
  const dimensionOf = new Map(unitRows.map((u) => [u.code, u.dimension]));

  const missingUnits = FIELDS.filter((f) => !dimensionOf.has(f.unit));
  if (missingUnits.length) {
    // Loud, not silent. A field with a NULL dimension accepts any unit and
    // converts none of them, so seeding one is worse than refusing to seed.
    throw new Error(
      `fab_units is missing ${missingUnits.length} unit code(s) these fields need: `
      + `${missingUnits.map((f) => `${f.unit} (for ${f.key})`).join(', ')}. `
      + 'fab_units is seeded by apps/fab_erp/models/init.sql and should hold 41 rows — '
      + `it currently holds ${unitRows.length}. Run init.sql before seeding.`,
    );
  }

  const [existing] = await conn.query(
    `SELECT id, field_key, label, data_type, dimension, default_unit, applies_at,
            formula_usable, is_standard, active, sort_order, deleted_at
       FROM fab_fields WHERE company_id = ?`,
    [companyId],
  );
  const byKey = new Map(existing.map((r) => [r.field_key, r]));

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const [i, f] of FIELDS.entries()) {
    const want = {
      label: f.label,
      data_type: 'number',
      dimension: dimensionOf.get(f.unit),
      default_unit: f.unit,
      applies_at: f.appliesAt,
      formula_usable: 1,
      is_standard: 1,
      active: 1,
    };
    const sortOrder = (i + 1) * 10;
    const row = byKey.get(f.key);

    if (!row) {
      created++;
      log(`+ ${f.key.padEnd(18)} ${want.dimension}/${f.unit} @ ${f.appliesAt}`);
      if (!apply) continue;
      await conn.query(
        `INSERT INTO fab_fields
           (company_id, field_key, label, data_type, dimension, default_unit,
            applies_at, formula_usable, default_num, is_standard, sort_order, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 1, ?, 1)`,
        [companyId, f.key, want.label, want.data_type, want.dimension,
          want.default_unit, want.applies_at, sortOrder],
      );
      continue;
    }

    // A soft-deleted definition is revived rather than duplicated — the unique
    // key is (company_id, field_key) and it does NOT exclude deleted rows, so
    // inserting over one would fail outright.
    const drift = MANAGED.filter((c) => !same(row[c], want[c]));
    const needsRevive = row.deleted_at != null;
    const needsSort = Number(row.sort_order) !== sortOrder;

    if (!drift.length && !needsRevive && !needsSort) { unchanged++; continue; }

    updated++;
    const why = [
      ...drift.map((c) => `${c}: ${row[c] ?? 'NULL'} -> ${want[c]}`),
      ...(needsRevive ? ['undeleted'] : []),
      ...(needsSort ? [`sort_order: ${row.sort_order} -> ${sortOrder}`] : []),
    ].join(', ');
    log(`~ ${f.key.padEnd(18)} ${why}`);
    if (!apply) continue;

    await conn.query(
      `UPDATE fab_fields
          SET label = ?, data_type = ?, dimension = ?, default_unit = ?, applies_at = ?,
              formula_usable = 1, is_standard = 1, active = 1, sort_order = ?, deleted_at = NULL
        WHERE id = ? AND company_id = ?`,
      [want.label, want.data_type, want.dimension, want.default_unit, want.applies_at,
        sortOrder, row.id, companyId],
    );
  }

  return { created, updated, unchanged };
}
