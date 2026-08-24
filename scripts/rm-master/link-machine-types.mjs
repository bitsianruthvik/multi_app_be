/**
 * link-machine-types.mjs — close the machine fork.
 *
 * Usage: node scripts/rm-master/link-machine-types.mjs <companyId> [--apply]
 *
 * WHAT THE FORK ACTUALLY WAS, having looked rather than assumed:
 *
 *   Identity was already RIGHT. Every fab_resources row points at a stock piece,
 *   and those pieces are instances of MACH-* catalogue items. Catalogue item =
 *   type, stock piece = instance, resource = the scheduling role over that
 *   piece. Nothing to fix.
 *
 *   The nine ASSET fields were the decoys, not the columns — the opposite of the
 *   first guess. `assetService` and MachineAssetPanel are a live feature reading
 *   fab_resources.asset_cost / purchase_date / warranty_until and the rest, and
 *   the matching stock_piece field definitions hold nothing and are read by
 *   nobody. They also fail the inheritance test: no category shares a warranty
 *   date. So they are identity, correctly columns, and the field definitions are
 *   retired.
 *
 *   The REAL fork was `fab_resource_type_properties`. Ten resource types and ten
 *   MACH-* catalogue items are the same concept twice over, matching ONE TO ONE
 *   BY NAME, with a parallel attribute mechanism hanging off the types (one key,
 *   `speed`, feeding `machine.speed` in every operation formula).
 *
 * A JOIN ON A NAME IS NOT A RELATIONSHIP. Rename either side and the machine
 * silently loses its speed, its taxonomy, and every field hung off it — with no
 * error anywhere, because a name that no longer matches simply finds nothing.
 * So the type now NAMES its catalogue item, and `speed` becomes a field.
 *
 * `applies_at: stock_piece` for speed, which is the narrowest rung it may sit on
 * and therefore permits every broader one. It reads oddly for a moment and is
 * exactly right: the TYPE says what a plasma cutter normally manages, and the
 * one tired machine in the corner can say otherwise on its own piece.
 */

import { pool } from '../../db.js';
import { upsertFieldValues } from './field-values.mjs';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
if (!companyId) {
  console.error('Usage: node scripts/rm-master/link-machine-types.mjs <companyId> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);

/** Decoy definitions: a live columnar feature already owns these. */
const RETIRE = ['asset_cost', 'asset_tag', 'commissioned_date', 'condition',
  'depreciation_method', 'purchase_date', 'salvage_value', 'useful_life_years', 'warranty_until'];

const conn = await pool.getConnection();
const did = [];
try {
  await conn.beginTransaction();

  // ── 1. the type names its catalogue item ─────────────────────────────────
  const [types] = await conn.query(
    `SELECT t.id, t.name, t.catalog_item_id, ic.id AS matchId, ic.code AS matchCode
       FROM fab_resource_types t
       LEFT JOIN fab_item_catalog ic
              ON ic.company_id = t.company_id AND ic.deleted_at IS NULL
             AND ic.code LIKE 'MACH-%' AND ic.name = t.name
      WHERE t.company_id = ? AND t.deleted_at IS NULL`,
    [companyId],
  );
  const linked = types.filter((t) => t.matchId && t.catalog_item_id == null);
  const already = types.filter((t) => t.catalog_item_id != null);
  const unmatched = types.filter((t) => !t.matchId && t.catalog_item_id == null);

  did.push(`resource types: ${types.length} total, ${already.length} already linked, `
    + `${linked.length} to link, ${unmatched.length} with no catalogue item`);
  for (const u of unmatched) did.push(`  ! "${u.name}" has no MACH-* item of that name — left alone`);
  if (apply) {
    for (const t of linked) {
      await conn.query('UPDATE fab_resource_types SET catalog_item_id = ? WHERE id = ?', [t.matchId, t.id]);
    }
  }

  // ── 2. speed becomes a field on the catalogue item ───────────────────────
  const [[speedField]] = await conn.query(
    'SELECT id FROM fab_fields WHERE company_id = ? AND field_key = ? LIMIT 1', [companyId, 'speed'],
  );
  let speedId = speedField?.id ?? null;
  if (!speedId) {
    did.push("field 'speed' created (number, @ stock_piece — a type default one machine may override)");
    if (apply) {
      const [ins] = await conn.query(
        `INSERT INTO fab_fields
           (company_id, field_key, label, data_type, dimension, default_unit, applies_at,
            formula_usable, is_standard, sort_order, active)
         VALUES (?, 'speed', 'Machine speed', 'number', NULL, NULL, 'stock_piece', 1, 1, 220, 1)`,
        [companyId],
      );
      speedId = ins.insertId;
    }
  }

  const [props] = await conn.query(
    `SELECT p.property_key, p.default_value, t.name, COALESCE(t.catalog_item_id, ic.id) AS itemId
       FROM fab_resource_type_properties p
       JOIN fab_resource_types t ON t.id = p.resource_type_id AND t.deleted_at IS NULL
       LEFT JOIN fab_item_catalog ic
              ON ic.company_id = t.company_id AND ic.deleted_at IS NULL
             AND ic.code LIKE 'MACH-%' AND ic.name = t.name
      WHERE t.company_id = ?`,
    [companyId],
  );
  const speeds = props.filter((p) => p.property_key === 'speed' && p.itemId && p.default_value != null);
  const otherKeys = [...new Set(props.filter((p) => p.property_key !== 'speed').map((p) => p.property_key))];
  did.push(`speed values: ${speeds.length} of ${props.length} type propert(ies) map to a catalogue item`);
  if (otherKeys.length) {
    did.push(`  ! other property keys present and NOT migrated: ${otherKeys.join(', ')} `
      + '— each needs its own field decision');
  }
  if (apply && speedId && speeds.length) {
    await upsertFieldValues(conn, {
      companyId, fieldId: speedId, scope: 'catalog_item', kind: 'num',
      entries: speeds.map((p) => ({ scopeId: p.itemId, value: Number(p.default_value) })),
    });
  }

  // ── 3. retire the asset decoys ───────────────────────────────────────────
  for (const key of RETIRE) {
    const [[f]] = await conn.query(
      `SELECT f.id, (SELECT COUNT(*) FROM fab_field_values v
                      WHERE v.field_id = f.id AND v.deleted_at IS NULL) held
         FROM fab_fields f
        WHERE f.company_id = ? AND f.field_key = ? AND f.deleted_at IS NULL LIMIT 1`,
      [companyId, key],
    );
    if (!f) continue;
    if (Number(f.held) > 0) {
      // Somebody has used it. The judgement above was about the design, not a
      // licence to delete values.
      did.push(`  ! ${key} holds ${f.held} value(s) — NOT retired, needs a decision`);
      continue;
    }
    did.push(`  ${key} retired (fab_resources column is the live implementation)`);
    if (apply) await conn.query('UPDATE fab_fields SET deleted_at = NOW(), active = 0 WHERE id = ?', [f.id]);
  }

  log(`\nmachine fork — company ${companyId}`);
  for (const d of did) log(`  ${d}`);
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
