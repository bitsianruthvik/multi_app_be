/**
 * add-grade.mjs — give the catalog a real `grade` field, and fill it in.
 *
 * Usage: node scripts/rm-master/add-grade.mjs <companyId> --file=<xlsx> [--apply]
 *
 * WHY THIS IS NEEDED BEFORE THE SUGGESTOR. Grade decides which plate a part may
 * be cut from — E350 and E250 are not interchangeable — and until now it existed
 * in exactly two places, both of them prose: inside an item's NAME
 * ("MS Plate 12 x 2300 x 12000 E350 BO") and inside its subgroup label. A
 * nesting suggestor that read either would be parsing text to make a
 * metallurgical decision, which is the failure mode the taxonomy was chosen to
 * avoid. So grade becomes a field with a value, like every other property.
 *
 * `applies_at: catalog_item` — the NARROWEST rung a grade may be set on. A
 * grade is a property of the material, not of one plate, so it may also be set
 * at subgroup, group or category and inherited; it may NOT be overridden per
 * stock piece, because a piece cannot be a different grade from the item it is
 * a piece of.
 *
 * VALUES ARE WRITTEN DIRECTLY rather than through setFields, and that is safe
 * HERE for one specific reason: `grade` is text and has no projection column
 * behind it (see PROJECTIONS in fieldProjection.js — only thickness_mm,
 * density_kg_m3 and section_area_mm2 project at catalog_item scope). Nothing is
 * left stale. Do not copy this shortcut for a field that does project.
 */

import ExcelJS from 'exceljs';
import { pool } from '../../db.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
const file = args.find((a) => a.startsWith('--file='))?.split('=')[1] ?? process.env.RM_MASTER_FILE;

if (!companyId || !file) {
  console.error('Usage: node scripts/rm-master/add-grade.mjs <companyId> --file=<Codes_Master.xlsx> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// ── grade per RM code, straight from the sheet ──────────────────────────────
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.getWorksheet('RM_Master');
if (!ws) throw new Error('No RM_Master sheet in that workbook');

const gradeByCode = new Map();
ws.eachRow((r, i) => {
  if (i === 1) return;
  const v = r.values;
  const code = String(v[11] ?? '').trim();
  const grade = String(v[9] ?? '').trim();
  if (code && grade) gradeByCode.set(code, grade);
});
log(`\nsheet: ${gradeByCode.size} codes, grades ${[...new Set(gradeByCode.values())].join(', ')}`);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  // ── the field ─────────────────────────────────────────────────────────────
  const [[existing]] = await conn.query(
    'SELECT id, deleted_at FROM fab_fields WHERE company_id = ? AND field_key = ? LIMIT 1',
    [companyId, 'grade'],
  );
  let fieldId = existing?.id ?? null;
  if (!existing) {
    log('  field: creating `grade` (text, applies_at catalog_item)');
    if (apply) {
      const [ins] = await conn.query(
        `INSERT INTO fab_fields
           (company_id, field_key, label, data_type, dimension, default_unit, applies_at,
            formula_usable, is_standard, sort_order, active)
         VALUES (?, 'grade', 'Steel grade', 'text', NULL, NULL, 'catalog_item', 0, 1, 200, 1)`,
        [companyId],
      );
      fieldId = ins.insertId;
    }
  } else {
    log(`  field: \`grade\` already exists (${existing.id})`);
    // The unique key is (company_id, field_key) and does not exclude deleted
    // rows, so a soft-deleted definition is revived, never re-inserted.
    if (existing.deleted_at && apply) {
      await conn.query('UPDATE fab_fields SET deleted_at = NULL, active = 1 WHERE id = ?', [existing.id]);
      log('         (revived a soft-deleted definition)');
    }
  }

  // ── which catalog items get a value ───────────────────────────────────────
  const [items] = await conn.query(
    `SELECT id, code FROM fab_item_catalog
      WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)`,
    [companyId, [...gradeByCode.keys()]],
  );
  log(`  catalog: ${items.length} of ${gradeByCode.size} RM codes are in this company`);

  if (!apply) {
    const sample = items.slice(0, 3).map((i) => `${i.code}=${gradeByCode.get(i.code)}`).join(', ');
    log(`  would write ${items.length} grade value(s)  e.g. ${sample}`);
    log('\nNothing written. Re-run with --apply.\n');
    await conn.rollback();
    process.exit(0);
  }

  // Idempotent: retire this field's previous answer for these items rather than
  // stacking a second live value beside it, which resolveFields would then have
  // to choose between.
  const ids = items.map((i) => i.id);
  for (const group of chunk(ids, 500)) {
    await conn.query(
      `UPDATE fab_field_values SET deleted_at = NOW()
        WHERE company_id = ? AND field_id = ? AND scope = 'catalog_item'
          AND scope_id IN (?) AND deleted_at IS NULL`,
      [companyId, fieldId, group],
    );
  }

  const rows = items.map((i) => [companyId, fieldId, 'catalog_item', i.id, gradeByCode.get(i.code)]);
  for (const group of chunk(rows, 900)) {
    await conn.query(
      'INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_text) VALUES ?',
      [group],
    );
  }
  log(`  grade values: ${rows.length}`);

  await conn.commit();
  log('  committed\n');
} catch (err) {
  await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}`);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
