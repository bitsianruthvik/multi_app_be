/**
 * verify-field-parity.mjs — does the new resolver say what the old one says?
 *
 * The gate for step 2 of FAB_ERP_FIELDS_REDESIGN.md. The formula engine is the
 * one consumer that must not regress, and it regresses SILENTLY: an `item_*`
 * symbol absent from scope is evaluated as 0 (formulaEngine.js:215), so a
 * dropped value does not error — the task simply plans as free, and every date
 * computed from it downstream is fiction.
 *
 * So this compares, per item, what `resolveItemFields` (old) and
 * `resolveFields` (new) produce, and reports every difference.
 *
 * WHAT COUNTS AS A DIFFERENCE, and what deliberately does not:
 *
 *   MISSING    the old resolver had a value, the new one does not.
 *              Always a regression. This is the one that plans work as free.
 *   CHANGED    both have it, numbers differ beyond rounding. Always a
 *              regression.
 *   ADDED      the new one has a value the old one did not. NOT a regression,
 *              and usually the point: the old resolver dropped every text field
 *              on the floor, so heat_no and serial_no appearing is the fix
 *              working. Reported separately so it can be read, not alarmed at.
 *
 * Only `formula_usable` fields are compared, because those are the only ones
 * that can reach a formula. A text field is compared as a string; a number is
 * compared to 6 decimal places, which is the precision the value column stores.
 *
 * Usage:  node scripts/verify-field-parity.mjs [companyId]
 */

import { pool } from '../db.js';
import { resolveItemFields } from '../apps/fab_erp/services/itemFieldService.js';
import { resolveFields, fieldRegistry } from '../apps/fab_erp/services/fieldService.js';

const only = Number(process.argv[2]) || null;
const round = (n) => Math.round(Number(n) * 1e6) / 1e6;

const [companies] = await pool.query(
  only ? 'SELECT id, name FROM companies WHERE id = ?'
    : `SELECT DISTINCT c.id, c.name FROM companies c
         JOIN fab_items i ON i.company_id = c.id AND i.deleted_at IS NULL`,
  only ? [only] : [],
);

let regressions = 0;

for (const co of companies) {
  console.log(`\n── ${co.name} (company ${co.id})`);

  const [items] = await pool.query(
    `SELECT id, name, code FROM fab_items
      WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY id`,
    [co.id],
  );
  if (!items.length) { console.log('   no items'); continue; }

  const ids = items.map((i) => i.id);
  const registry = await fieldRegistry(co.id);
  const formulaKeys = new Set(
    registry.rows.filter((f) => Number(f.formulaUsable)).map((f) => f.fieldKey),
  );

  const oldVals = await resolveItemFields(co.id, ids);
  const newMap = await resolveFields(
    co.id, ids.map((id) => ({ scope: 'order_item', scopeId: id })), { registry },
  );

  const missing = [];
  const changed = [];
  const added = [];

  for (const item of items) {
    const o = oldVals.get(item.id) ?? {};
    const n = newMap.get(`order_item:${item.id}`) ?? {};
    const label = `${item.code?.split('-').slice(-2).join('-') ?? item.id} ${item.name ?? ''}`.trim();

    for (const key of formulaKeys) {
      const ov = o[key];
      const nvEntry = n[key];
      const nv = nvEntry?.value;

      if (ov != null && nv == null) {
        missing.push({ label, key, ov });
      } else if (ov != null && nv != null) {
        const same = typeof ov === 'number' || typeof nv === 'number'
          ? round(ov) === round(nv)
          : String(ov) === String(nv);
        if (!same) changed.push({ label, key, ov, nv, from: nvEntry.from });
      } else if (ov == null && nv != null) {
        added.push({ label, key, nv });
      }
    }
  }

  console.log(`   ${items.length} item(s), ${formulaKeys.size} formula-usable field(s)`);

  if (missing.length) {
    regressions += missing.length;
    console.log(`\n   MISSING — the old resolver had these and the new one does not (${missing.length}):`);
    for (const m of missing.slice(0, 12)) console.log(`     ${m.label}  ${m.key} = ${m.ov}`);
    if (missing.length > 12) console.log(`     ... and ${missing.length - 12} more`);
  }
  if (changed.length) {
    regressions += changed.length;
    console.log(`\n   CHANGED — both have a value and they disagree (${changed.length}):`);
    for (const c of changed.slice(0, 12)) {
      console.log(`     ${c.label}  ${c.key}: old ${c.ov} -> new ${c.nv} (from ${c.from?.scope})`);
    }
    if (changed.length > 12) console.log(`     ... and ${changed.length - 12} more`);
  }
  if (added.length) {
    // Not counted as a regression. Mostly the text fields the old resolver
    // dropped by design.
    const byKey = new Map();
    for (const a of added) byKey.set(a.key, (byKey.get(a.key) ?? 0) + 1);
    console.log(`\n   ADDED — new values the old resolver did not return (${added.length}, not a regression):`);
    for (const [k, n] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`     ${String(n).padStart(4)} x ${k}`);
    }
  }
  if (!missing.length && !changed.length) console.log('\n   No regression: every value the old resolver produced, the new one produces.');
}

console.log(regressions === 0
  ? '\nPARITY — safe to repoint the formula engine.'
  : `\n${regressions} regression(s). Do NOT repoint until these are explained.`);

await pool.end();
