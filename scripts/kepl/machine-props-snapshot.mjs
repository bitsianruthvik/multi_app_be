/**
 * machine-props-snapshot.mjs — what does `machine.*` resolve to right now?
 *
 * Usage: node scripts/kepl/machine-props-snapshot.mjs <companyId>
 *
 * Run before and after linking resource types to their catalogue items. Every
 * value must be IDENTICAL: the migration copies each type property into a field
 * and the resolver prefers the field, so the number a formula sees must not move.
 * If it moves, the migration is wrong and `catalog_item_id = NULL` reverts it.
 */
import { pool } from '../../db.js';
import { evaluateFormula } from '../../apps/fab_erp/services/formulaEngine.js';

const companyId = Number(process.argv[2]);
if (!companyId) { console.error('Usage: node scripts/kepl/machine-props-snapshot.mjs <companyId>'); process.exit(1); }

const [types] = await pool.query(
  'SELECT id, name FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
  [companyId],
);
const out = [];
for (const t of types) {
  // A formula that reports the value straight back, so this measures resolution
  // rather than arithmetic.
  const v = await evaluateFormula('machine.speed', {}, {}, t.id, {}, null, null);
  out.push(`${t.name}\t${v === null ? 'null' : v}`);
}
console.log(out.join('\n'));
await pool.end();
