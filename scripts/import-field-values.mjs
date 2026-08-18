/**
 * import-field-values.mjs — fill fab_field_values from everywhere values live today.
 *
 * Step 2 of FAB_ERP_FIELDS_REDESIGN.md needs the new resolver to return what the
 * old one returns, and it cannot do that against an empty table. So this pulls
 * from BOTH current sources:
 *
 *   1. fab_custom_fields          the explicit values, all six levels
 *   2. the duplicated COLUMNS     thickness/density/section area on the catalog,
 *                                 length/width/height on order items, length/width
 *                                 on stock pieces
 *
 * Source 2 matters more than it looks. `density_kg_m3` lives only as a catalog
 * COLUMN, and every weight in the system is volume x density — so a parity run
 * without it would report every weight as regressed, and repointing on that
 * basis would silently zero them.
 *
 * NOT A MIGRATION. It writes through `setFields`, which validates, so anything
 * the old unvalidated /mutate path let in gets REJECTED here and reported rather
 * than carried forward. That report is the point as much as the data is: it is
 * the first time this data has been checked against its own vocabulary.
 *
 * Re-runnable. Every write is an upsert on uq_ffv_target.
 *
 * Usage:  node scripts/import-field-values.mjs [companyId] [--dry]
 */

import { pool } from '../db.js';
import { setFields, fieldRegistry } from '../apps/fab_erp/services/fieldService.js';
import { mayHoldValue } from '../apps/fab_erp/services/fieldLadder.js';

const only = Number(process.argv[2]) || null;
const dry = process.argv.includes('--dry');

/** The old `level` vocabulary, mapped onto the one ladder. */
const SCOPE_OF = {
  category: 'category',
  group: 'group',
  subgroup: 'subgroup',
  item: 'catalog_item',
  order_item: 'order_item',
  stock_piece: 'stock_piece',
};

/**
 * Columns that hold a field's value today, by the scope they sit at.
 *
 * `height` -> `thickness_mm` is the mapping that must never be "corrected": the
 * BOQ sheet's Thick column is declared with key `height`, so fab_items.height IS
 * thickness. Anything that maps it to a height_mm silently destroys every
 * thickness in the system.
 */
const COLUMN_SOURCES = [
  {
    scope: 'catalog_item',
    table: 'fab_item_catalog',
    map: { thickness_mm: 'thickness_mm', density_kg_m3: 'density_kg_m3', section_area_mm2: 'section_area_mm2' },
  },
  {
    scope: 'order_item',
    table: 'fab_items',
    map: { length_mm: 'length', width_mm: 'width', thickness_mm: 'height' },
  },
  {
    scope: 'stock_piece',
    table: 'fab_stock_pieces',
    map: { length_mm: 'length_mm', width_mm: 'width_mm' },
  },
];

const [companies] = await pool.query(
  only ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_fields f ON f.company_id = c.id AND f.deleted_at IS NULL`,
  only ? [only] : [],
);

let grandWritten = 0;
let grandRejected = 0;

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);
  const registry = await fieldRegistry(co.id);
  const rejections = new Map(); // "why" -> count

  const note = (why) => {
    rejections.set(why, (rejections.get(why) ?? 0) + 1);
    grandRejected++;
  };

  // ── 1. the explicit values ────────────────────────────────────────────────
  const [cf] = await pool.query(
    `SELECT level, level_id AS levelId, field_key AS fieldKey, field_value AS fieldValue
       FROM fab_custom_fields
      WHERE company_id = ? AND deleted_at IS NULL AND field_value IS NOT NULL AND field_value <> ''`,
    [co.id],
  );

  // Grouped per target, so one setFields call carries every key for a row.
  const byTarget = new Map();
  for (const r of cf) {
    const scope = SCOPE_OF[r.level];
    if (!scope) { note(`unknown level "${r.level}"`); continue; }
    const f = registry.byKey.get(r.fieldKey);
    if (!f) { note(`no field definition for "${r.fieldKey}"`); continue; }
    if (!mayHoldValue(f, scope)) { note(`"${r.fieldKey}" cannot be set on a ${scope}`); continue; }
    const k = `${scope}:${r.levelId}`;
    if (!byTarget.has(k)) byTarget.set(k, { scope, scopeId: r.levelId, values: {} });
    byTarget.get(k).values[r.fieldKey] = r.fieldValue;
  }
  console.log(`   fab_custom_fields: ${cf.length} row(s) -> ${byTarget.size} target(s)`);

  // ── 2. the duplicated columns ─────────────────────────────────────────────
  for (const src of COLUMN_SOURCES) {
    const cols = Object.entries(src.map).filter(([key]) => registry.byKey.has(key));
    if (!cols.length) continue;
    const select = cols.map(([, col]) => `\`${col}\``).join(', ');
    const where = cols.map(([, col]) => `\`${col}\` IS NOT NULL`).join(' OR ');
    const [rows] = await pool.query(
      `SELECT id, ${select} FROM ${src.table}
        WHERE company_id = ? AND deleted_at IS NULL AND (${where})`,
      [co.id],
    );
    let added = 0;
    for (const row of rows) {
      const k = `${src.scope}:${row.id}`;
      if (!byTarget.has(k)) byTarget.set(k, { scope: src.scope, scopeId: row.id, values: {} });
      const t = byTarget.get(k);
      for (const [key, col] of cols) {
        if (row[col] == null) continue;
        // An explicit value already collected outranks the column — the old
        // chain read columns BELOW custom fields, and parity depends on keeping
        // that order.
        if (t.values[key] !== undefined) continue;
        const f = registry.byKey.get(key);
        if (!mayHoldValue(f, src.scope)) continue;
        t.values[key] = row[col];
        added++;
      }
    }
    console.log(`   ${src.table}: ${rows.length} row(s), ${added} value(s) from columns`);
  }

  const tally = () => {
    if (!rejections.size) return;
    console.log(`   rejected:`);
    for (const [why, n] of [...rejections].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)} x ${why}`);
    }
  };

  if (dry) {
    console.log(`   [dry] would write ${[...byTarget.values()].reduce((n, t) => n + Object.keys(t.values).length, 0)} value(s)`);
    tally();
    continue;
  }

  let written = 0;
  for (const t of byTarget.values()) {
    const res = await setFields(co.id, t.scope, t.scopeId, t.values);
    written += res.written;
    for (const r of res.rejected) note(r.why);
  }
  grandWritten += written;
  console.log(`   WROTE ${written} value(s)`);

  tally();
}

console.log(`\n${grandWritten} value(s) written, ${grandRejected} rejected.`);
console.log(grandRejected
  ? 'Rejections are data the old unvalidated /mutate path allowed in. Nothing was lost — the old table still has them.'
  : 'Nothing rejected.');
await pool.end();
