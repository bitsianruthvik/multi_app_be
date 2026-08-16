/**
 * verify-field-consolidation.mjs — did Phase 2 lose anything?
 *
 * Read-only. Run after the Phase 2 seed, on every environment, before trusting
 * it. The plan's rule 3: every migration ships with a verifier that re-derives
 * the affected data and reports differences.
 *
 * It answers four questions:
 *
 *   1. Is every custom-field VALUE still described by an active definition?
 *      A value whose definition was retired without its data being carried
 *      across is data nobody can see and nothing can validate.
 *   2. Did every free-text value that should have moved actually move?
 *      Values that would not convert are deliberately left in place rather than
 *      dropped, so they must be listed rather than assumed.
 *   3. Does every definition use a unit and data type the vocabulary knows?
 *      An unknown unit means the picker renders blank and somebody retypes it.
 *   4. Does every existing value satisfy its definition's picker?
 *      Adding allowed_values to a field that already has values can strand
 *      them — and a stranded value still displays, so nobody notices.
 *
 * Usage:  node scripts/verify-field-consolidation.mjs [companyId]
 */

import { pool } from '../db.js';
import {
  isKnownUnit, isKnownDataType, isKnownLevel, parseAllowedValues, validateFieldValue,
} from '../apps/fab_erp/services/fieldVocabulary.js';

const only = Number(process.argv[2]) || null;

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_field_defs d ON d.company_id = c.id AND d.deleted_at IS NULL`,
  only ? [only] : [],
);

let problems = 0;
const flag = (msg) => { problems++; console.log(`   ⚠ ${msg}`); };

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  const [defs] = await pool.query(
    `SELECT field_key, label, data_type, unit, level, allowed_values, active, category_id
       FROM fab_field_defs WHERE company_id = ? AND deleted_at IS NULL`,
    [co.id],
  );
  const byKey = new Map(defs.map((d) => [d.field_key, d]));
  const active = defs.filter((d) => Number(d.active) === 1);
  console.log(`   ${defs.length} definitions · ${active.length} active · ` +
              `${active.filter((d) => d.category_id).length} scoped to a category`);

  // 1 — values with no active definition
  const [orphans] = await pool.query(
    `SELECT c.field_key, c.level, COUNT(*) AS n
       FROM fab_custom_fields c
      WHERE c.company_id = ? AND c.deleted_at IS NULL
      GROUP BY c.field_key, c.level`,
    [co.id],
  );
  for (const o of orphans) {
    const d = byKey.get(o.field_key);
    if (!d) flag(`${o.n} value(s) of "${o.field_key}" (${o.level}) have NO definition at all`);
    else if (Number(d.active) !== 1) {
      flag(`${o.n} value(s) of "${o.field_key}" (${o.level}) sit under a RETIRED definition — ` +
           'either carry them across or un-retire it');
    }
  }

  // 2 — free-text keys that were supposed to move
  const MOVED = {
    'Rate (INR/kg)': 'rate_per_kg',
    'Sell Rate (INR/kg)': 'sell_rate_per_kg',
    'Estimated Value (INR)': 'estimated_value',
    'Total Steel Weight (kg)': 'total_steel_weight_kg',
    // Grade is deliberately absent: it was upgraded IN PLACE rather than
    // replaced, because fab_custom_fields.field_key collates case-insensitively
    // and a lowercase 'grade' is the SAME key to it.

  };
  for (const [oldKey, newKey] of Object.entries(MOVED)) {
    const [[left]] = await pool.query(
      `SELECT COUNT(*) AS n FROM fab_custom_fields c
        WHERE c.company_id = ? AND c.deleted_at IS NULL AND c.field_key = ?
          AND NOT EXISTS (SELECT 1 FROM fab_custom_fields x
                           WHERE x.company_id = c.company_id AND x.level = c.level
                             AND x.level_id = c.level_id AND x.field_key = ?
                             AND x.deleted_at IS NULL)`,
      [co.id, oldKey, newKey],
    );
    if (Number(left.n) > 0) {
      // Not necessarily a fault — a value that would not convert is left where
      // it is on purpose. But it has to be SEEN.
      flag(`${left.n} value(s) of "${oldKey}" did not move to "${newKey}" — ` +
           'they did not convert, and are still readable under the old key');
    }
  }

  // 3 — vocabulary
  for (const d of active) {
    if (!isKnownUnit(d.unit)) flag(`"${d.field_key}" uses unit "${d.unit}", which the vocabulary does not know`);
    if (!isKnownDataType(d.data_type) && d.data_type !== 'integer') {
      flag(`"${d.field_key}" has data type "${d.data_type}", which the vocabulary does not know`);
    }
    if (d.level && !isKnownLevel(d.level)) flag(`"${d.field_key}" has level "${d.level}"`);
  }

  // 4 — values stranded by a picker
  const pickers = active.filter((d) => parseAllowedValues(d.allowed_values));
  for (const d of pickers) {
    const [vals] = await pool.query(
      `SELECT DISTINCT field_value FROM fab_custom_fields
        WHERE company_id = ? AND field_key = ? AND deleted_at IS NULL
          AND field_value IS NOT NULL AND field_value <> ''`,
      [co.id, d.field_key],
    );
    for (const v of vals) {
      const r = validateFieldValue(d, v.field_value);
      if (!r.ok) flag(`"${d.field_key}" holds "${v.field_value}" which its picker rejects — ${r.reason}`);
    }
  }
}

console.log(problems === 0
  ? '\nCLEAN — every value has an active definition, everything convertible moved, ' +
    'and no value is stranded by a picker.'
  : `\nREVIEW — ${problems} thing(s) to look at above.`);

await pool.end();
