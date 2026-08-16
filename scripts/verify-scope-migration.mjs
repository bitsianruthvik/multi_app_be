/**
 * verify-scope-migration.mjs — does the scope offer the same material, or less?
 *
 * Read-only. Phase 7 replaces the material picker's SUBTRACTION rule
 * (everything bought, minus consumables and fasteners) with an INCLUSION over
 * the taxonomy.
 *
 * The test that matters is directional. The new list must be identical to, or
 * a SUBSET of, the old one:
 *
 *   removed  expected and wanted — that is the leak being closed
 *   ADDED    a rule error. Something is now offered as material that was not
 *            before, and the whole point of an inclusion is that it cannot
 *            widen by accident.
 *
 * Also checks that the resolution chain never returns nothing, since an empty
 * picker is indistinguishable from an empty yard to whoever hits it.
 *
 * Usage:  node scripts/verify-scope-migration.mjs [companyId]
 */

import { pool } from '../db.js';
import { rawMaterialsFor } from '../apps/fab_erp/services/rawMaterialService.js';
import { pickList, resolveScope } from '../apps/fab_erp/services/itemScopeService.js';

const only = Number(process.argv[2]) || null;
let problems = 0;
const flag = (m) => { problems++; console.log(`   ⚠ ${m}`); };

const [companies] = await pool.query(
  only
    ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_item_catalog i ON i.company_id = c.id AND i.deleted_at IS NULL`,
  only ? [only] : [],
);

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  const oldList = await rawMaterialsFor(co.id);
  const { scope, items: newList } = await pickList(co.id, 'bom_material');

  if (!scope) {
    flag('no bom_material binding — the picker would have nothing to resolve to');
    continue;
  }

  const oldIds = new Set(oldList.map((m) => Number(m.id)));
  const newIds = new Set(newList.map((m) => Number(m.id)));
  const removed = oldList.filter((m) => !newIds.has(Number(m.id)));
  const added = newList.filter((m) => !oldIds.has(Number(m.id)));

  console.log(`   scope "${scope.scopeKey}" (${scope.label})`);
  console.log(`   old rule offered ${oldList.length} · new scope offers ${newList.length}`);

  for (const m of removed) console.log(`   -  no longer offered: ${m.code} — ${m.name}`);
  for (const m of added) {
    flag(`NOW OFFERED but was not before: ${m.code} — ${m.name} (${m.categoryCode ?? 'no category'})`);
  }
  if (!removed.length && !added.length) console.log('   identical to the old rule');

  if (newList.length === 0 && oldList.length > 0) {
    flag('the new scope offers NOTHING while the old rule offered material — the picker would look like an empty yard');
  }

  // The chain must survive an unknown line type and level.
  const fallback = await resolveScope(co.id, 'bom_material', {
    lineType: 'no-such-type', levelKind: 'no-such-level',
  });
  console.log(fallback
    ? `   unknown line type/level falls back to "${fallback.scopeKey}"`
    : '   ⚠ unknown line type/level resolves to NOTHING');
  if (!fallback) problems++;

  for (const purpose of ['spares', 'machines']) {
    const p = await pickList(co.id, purpose);
    console.log(`   ${purpose}: ${p.scope ? `${p.items.length} item(s)` : 'NO BINDING'}`);
    if (!p.scope) flag(`${purpose} has no binding`);
  }
}

console.log(problems === 0
  ? '\nCLEAN — the scope is identical or narrower, and nothing resolves to an empty list.'
  : `\nREVIEW — ${problems} problem(s) above.`);

await pool.end();
