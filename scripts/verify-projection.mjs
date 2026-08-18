/**
 * verify-projection.mjs — do the derived columns still agree with their values?
 *
 * The gate for step 4 of FAB_ERP_FIELDS_REDESIGN.md. Thirteen keys exist as both
 * a field value and a column; the value is the system of record and the column
 * is a projection `setFields` writes. This checks the projection has not drifted.
 *
 * DRIFT IS ONE-WAY AND SILENT. A writer that sets a column directly, bypassing
 * `setFields`, updates the projection without the value it is supposed to be
 * derived from. Nothing errors. The screen shows the new number, the matcher
 * reads the new number, and the formula engine reads the OLD one — so a part is
 * cut to one size and estimated at another. That is the failure this catches,
 * and it is why every column writer had to move before the columns could be
 * trusted as derived.
 *
 * THREE OUTCOMES, and only one of them is a problem:
 *
 *   DRIFTED    value and column disagree. A writer is bypassing setFields.
 *   COLUMN-ONLY  a column has a number and no value exists. Same cause, and
 *              worse in one way: the formula engine sees nothing at all.
 *   VALUE-ONLY a value exists and the column is null. Expected and fine while
 *              the import has run but a projection has not — reported quietly.
 *
 * Run after any change to a writer. When it is clean AND nothing reads the
 * columns any more, they can be dropped.
 *
 * Usage:  node scripts/verify-projection.mjs [companyId]
 */

import { pool } from '../db.js';
import { PROJECTIONS } from '../apps/fab_erp/services/fieldProjection.js';

const only = Number(process.argv[2]) || null;
const round = (n) => (n == null ? null : Math.round(Number(n) * 1e6) / 1e6);

const [companies] = await pool.query(
  only ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_fields f ON f.company_id = c.id AND f.deleted_at IS NULL`,
  only ? [only] : [],
);

let problems = 0;

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  for (const [scope, spec] of Object.entries(PROJECTIONS)) {
    for (const [fieldKey, column] of Object.entries(spec.columns)) {
      // The value and the column side by side, for every row that has either.
      const [rows] = await pool.query(
        `SELECT t.id,
                t.\`${column}\` AS col,
                v.value_num    AS val
           FROM ${spec.table} t
           LEFT JOIN fab_fields f
             ON f.company_id = t.company_id AND f.field_key = ? AND f.deleted_at IS NULL
           LEFT JOIN fab_field_values v
             ON v.company_id = t.company_id AND v.field_id = f.id
            AND v.scope = ? AND v.scope_id = t.id AND v.deleted_at IS NULL
          WHERE t.company_id = ? AND t.deleted_at IS NULL
            AND (t.\`${column}\` IS NOT NULL OR v.value_num IS NOT NULL)`,
        [fieldKey, scope, co.id],
      );
      if (!rows.length) continue;

      const drifted = [];
      let columnOnly = 0;
      let valueOnly = 0;
      for (const r of rows) {
        const c = round(r.col);
        const v = round(r.val);
        if (c != null && v != null) { if (c !== v) drifted.push({ id: r.id, c, v }); }
        else if (c != null) columnOnly++;
        else valueOnly++;
      }

      const label = `${spec.table}.${column} <- ${fieldKey}`;
      if (drifted.length || columnOnly) {
        problems += drifted.length + columnOnly;
        console.log(`\n   ${label}`);
        if (drifted.length) {
          console.log(`     DRIFTED ${drifted.length} row(s) — a writer is bypassing setFields:`);
          for (const d of drifted.slice(0, 6)) console.log(`       #${d.id}  column ${d.c} vs value ${d.v}`);
          if (drifted.length > 6) console.log(`       ... and ${drifted.length - 6} more`);
        }
        if (columnOnly) {
          console.log(`     COLUMN-ONLY ${columnOnly} row(s) — the formula engine sees nothing here`);
        }
      } else {
        console.log(`   ${label.padEnd(46)} ${rows.length - valueOnly} matched`
          + (valueOnly ? `, ${valueOnly} value-only (not yet projected)` : ''));
      }
    }
  }
}

console.log(problems === 0
  ? '\nCLEAN — every column agrees with the value it is derived from.'
  : `\n${problems} row(s) where the column and the value disagree, or the column stands alone.`);

await pool.end();
