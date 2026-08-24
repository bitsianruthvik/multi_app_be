/**
 * fix-attribute-homes.mjs — put every attribute where the design says it lives.
 *
 * Usage: node scripts/rm-master/fix-attribute-homes.mjs <companyId> [--apply]
 *
 * THE RULE. An attribute lives in the field registry and resolves up the ladder;
 * a column may exist as a CACHE of that field (see fieldProjection.js) but never
 * as its own source of truth. Three ways that was being broken:
 *
 * 1. THE INVERSION, and it is mine. `density_kg_m3` and `section_area_mm2` are
 *    declared projections — field is source, column is cache — and the RM
 *    importer and the catalogue repair both wrote the COLUMN directly. Result:
 *    1,420 densities and 1,106 section areas in columns, 10 and 2 in fields.
 *    Exactly backwards, and invisible because every reader happens to read the
 *    column. The field is populated from the column here, which makes the column
 *    a true cache again rather than the only copy.
 *
 * 2. DECOY FIELDS. `material_form` has a field definition holding ZERO values
 *    while its column holds 1,420 and every reader uses the column. A defined
 *    field that nothing reads and nothing writes is worse than no field: the
 *    next person sets it, nothing happens, and the reason is invisible.
 *
 * 3. A FIELD MUST EARN ITS PLACE, and the test is INHERITANCE. A grade can be
 *    inherited — "this whole order is E350" is a sentence a drawing says. A heat
 *    number cannot: it identifies one physical plate and no category, group or
 *    order can have one. So `heat_no`, `batch_no` and `serial_no` are NOT
 *    attributes to migrate; they are identity, and their decoy field definitions
 *    are retired rather than filled. Mechanically converting every column to a
 *    field would have got this exactly wrong.
 */

import { pool } from '../../db.js';
import { upsertFieldValues } from './field-values.mjs';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
if (!companyId) {
  console.error('Usage: node scripts/rm-master/fix-attribute-homes.mjs <companyId> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/**
 * Columns whose FIELD should hold the value, keyed by field. `numeric` decides
 * which value column the row lands in.
 */
const BACKFILL = [
  { key: 'density_kg_m3', column: 'density_kg_m3', numeric: true, unit: 'kg/m3' },
  { key: 'section_area_mm2', column: 'section_area_mm2', numeric: true, unit: 'mm2' },
  { key: 'material_form', column: 'material_form', numeric: false, unit: null },
];

/**
 * Field definitions to retire: identity, not attributes. A heat number cannot be
 * inherited from anything, so a ladder rung for it is meaningless.
 */
const RETIRE = ['heat_no', 'batch_no', 'serial_no'];

const conn = await pool.getConnection();
const did = [];
try {
  await conn.beginTransaction();

  const [fields] = await conn.query(
    `SELECT id, field_key, applies_at, data_type FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const byKey = new Map(fields.map((f) => [f.field_key, f]));

  // ── 1 & 2: the field becomes the source of truth ─────────────────────────
  for (const b of BACKFILL) {
    const f = byKey.get(b.key);
    if (!f) { did.push(`! ${b.key.padEnd(17)} no field definition — skipped`); continue; }

    const [rows] = await conn.query(
      `SELECT ic.id, ic.\`${b.column}\` AS val FROM fab_item_catalog ic
        WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.\`${b.column}\` IS NOT NULL`,
      [companyId],
    );
    const [[held]] = await conn.query(
      `SELECT COUNT(*) n FROM fab_field_values
        WHERE company_id = ? AND field_id = ? AND scope = 'catalog_item' AND deleted_at IS NULL`,
      [companyId, f.id],
    );
    did.push(`  ${b.key.padEnd(17)} column has ${String(rows.length).padStart(5)}, `
      + `field has ${String(held.n).padStart(5)} -> writing ${rows.length}`);
    if (!apply || !rows.length) continue;

    /**
     * UPSERT, not delete-then-insert. uq_ffv_target is unique on
     * (company_id, field_id, scope, scope_id) and ignores deleted_at, so there
     * is only ever one row per target and the old pattern dies on a duplicate
     * key the moment a target already has a value — which is exactly the case
     * here for the ten densities and two section areas already recorded.
     */
    await upsertFieldValues(conn, {
      companyId, fieldId: f.id, scope: 'catalog_item',
      kind: b.numeric ? 'num' : 'text', unit: b.unit,
      entries: rows.map((r) => ({ scopeId: r.id, value: b.numeric ? Number(r.val) : String(r.val) })),
    });
  }

  // ── 3: retire the definitions that were never attributes ─────────────────
  for (const key of RETIRE) {
    const f = byKey.get(key);
    if (!f) { did.push(`  ${key.padEnd(17)} already absent`); continue; }
    const [[held]] = await conn.query(
      `SELECT COUNT(*) n FROM fab_field_values
        WHERE company_id = ? AND field_id = ? AND deleted_at IS NULL`,
      [companyId, f.id],
    );
    if (Number(held.n) > 0) {
      // Someone has actually used it. Retiring it would delete real data, so it
      // is reported instead — the judgement above was about the design, not a
      // licence to drop values.
      did.push(`! ${key.padEnd(17)} holds ${held.n} value(s) — NOT retired, needs a decision`);
      continue;
    }
    did.push(`  ${key.padEnd(17)} retired (identity, not an attribute; 0 values)`);
    if (apply) {
      await conn.query('UPDATE fab_fields SET deleted_at = NOW(), active = 0 WHERE id = ?', [f.id]);
    }
  }

  /**
   * `hsn_code` is a genuine attribute and IS inheritable — a whole category of
   * plate shares one tax code — so it earns a field. Its column holds nothing,
   * so there is no migration, only a home for the next person who needs it.
   */
  if (!byKey.has('hsn_code')) {
    did.push('  hsn_code          field created (inheritable tax attribute; column is empty)');
    if (apply) {
      await conn.query(
        `INSERT INTO fab_fields
           (company_id, field_key, label, data_type, dimension, default_unit, applies_at,
            formula_usable, is_standard, sort_order, active)
         VALUES (?, 'hsn_code', 'HSN code', 'text', NULL, NULL, 'catalog_item', 0, 1, 210, 1)`,
        [companyId],
      );
    }
  }

  log(`\nattribute homes — company ${companyId}`);
  for (const d of did) log(d);

  if (!apply) { await conn.rollback(); log('\nNothing written. Re-run with --apply.\n'); }
  else { await conn.commit(); log('\n  committed\n'); }
} catch (err) {
  await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}`);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
