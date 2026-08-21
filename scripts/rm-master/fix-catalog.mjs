/**
 * fix-catalog.mjs — repair what the 2026-08-21 catalog audit found.
 *
 * Usage: node scripts/rm-master/fix-catalog.mjs <companyId> --file=<xlsx> [--apply]
 *
 * Each repair below is here because something in the system reads the field and
 * gets a WRONG ANSWER today, not because the data looks untidy. Anything the
 * audit found that cannot be fixed from the data we hold is deliberately left
 * alone and reported instead — see the tail of the run.
 */

import ExcelJS from 'exceljs';
import { pool } from '../../db.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
const file = args.find((a) => a.startsWith('--file='))?.split('=')[1] ?? process.env.RM_MASTER_FILE;
if (!companyId || !file) {
  console.error('Usage: node scripts/rm-master/fix-catalog.mjs <companyId> --file=<Codes_Master.xlsx> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const NA = (v) => v === 'NA' || v == null || v === '';
const num = (v) => (NA(v) ? null : Number(v));

// ── the sheet, for the one dimension the import never stored ────────────────
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.getWorksheet('RM_Master');
const sheet = new Map(); // code -> {depth, width, web, desc}
ws.eachRow((r, i) => {
  if (i === 1) return;
  const v = r.values;
  const code = String(v[11] ?? '').trim();
  if (code) sheet.set(code, { desc: v[2], depth: num(v[3]), width: num(v[5]), web: num(v[7]) });
});

const conn = await pool.getConnection();
const did = [];
const left = [];
try {
  await conn.beginTransaction();

  /**
   * 1. material_form vocabulary — the value must be one the CODE understands.
   *
   * rawMaterialService.js:153,162 and its frontend mirror both test exactly
   * `material_form === 'section'`; everything else is treated as flat plate.
   * The import wrote 'angle' / 'beam' / 'channel', which is more descriptive and
   * which nothing reads — so 1,236 profiles were being filtered by leg
   * thickness as though it were a plate thickness, and the plate-thickness
   * picker was padded with 38 thicknesses no plate is stocked in.
   *
   * The specific kind is NOT lost: group_id already records Angles / Beams /
   * Channels. Fixing the data rather than widening the test in two repos is the
   * lower-risk half — that file's own comment records that the two copies have
   * drifted before.
   */
  const [prof] = await conn.query(
    `SELECT id FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL
       AND material_form IN ('angle','beam','channel')`,
    [companyId],
  );
  did.push(`material_form -> 'section' on ${prof.length} profile(s) (kind stays in the group)`);
  if (apply && prof.length) {
    await conn.query(
      `UPDATE fab_item_catalog SET material_form = 'section'
        WHERE company_id = ? AND deleted_at IS NULL AND material_form IN ('angle','beam','channel')`,
      [companyId],
    );
  }

  /** 2. A machine is not made of plate. */
  const [mach] = await conn.query(
    `SELECT id, code FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL
       AND material_form IS NOT NULL AND code LIKE 'MACH-%'`,
    [companyId],
  );
  did.push(`material_form -> NULL on ${mach.length} machine(s): ${mach.map((m) => m.code).join(', ')}`);
  if (apply && mach.length) {
    await conn.query(
      'UPDATE fab_item_catalog SET material_form = NULL WHERE id IN (?)',
      [mach.map((m) => m.id)],
    );
  }

  /**
   * 3. Section area for ANGLES ONLY.
   *
   * itemWeightService uses section_area x length when present and silently
   * falls back to thickness x width x length when it is not — which is 47% light
   * on an angle, and the BOQ and nesting workbooks print that wrong rule as
   * written guidance for the shop floor.
   *
   * An angle's area is (legA + legB - t) x t, ignoring the root radius. Checked
   * against the one IS 808 figure already in this catalog — ISA 100x100x10,
   * stored 1898.089 — the formula gives 1900, which is 0.10% out.
   *
   * BEAMS AND CHANNELS ARE NOT COMPUTED. Their area needs the FLANGE thickness
   * and the sheet carries only the web. A web-only guess is 57% light on an
   * ISMC 200, which is worse than the fallback it would replace. They are
   * reported at the end instead of being filled with a plausible-looking wrong
   * number.
   */
  const [angles] = await conn.query(
    `SELECT ic.id, ic.code, ic.thickness_mm AS t FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name = 'Angles'
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.section_area_mm2 IS NULL`,
    [companyId],
  );
  let areaSet = 0;
  const areaRows = [];
  for (const a of angles) {
    const s = sheet.get(a.code);
    const t = num(a.t) ?? s?.web;
    if (!s || s.depth == null || s.width == null || t == null) continue;
    areaRows.push([a.id, Math.round(((s.depth + s.width - t) * t) * 1000) / 1000]);
  }
  did.push(`section_area_mm2 computed for ${areaRows.length} angle(s) from (legA+legB-t)*t`);
  if (apply) {
    for (const g of chunk(areaRows, 200)) {
      await conn.query(
        `UPDATE fab_item_catalog SET section_area_mm2 = ELT(FIELD(id, ${g.map(() => '?').join(',')}), ${g.map(() => '?').join(',')})
          WHERE id IN (${g.map(() => '?').join(',')})`,
        [...g.map((r) => r[0]), ...g.map((r) => r[1]), ...g.map((r) => r[0])],
      );
      areaSet += g.length;
    }
  }

  /**
   * 4. Depth — the dimension the import read and then dropped.
   *
   * A profile's name is `<designation> D x B x t x L`, but only t, B and L were
   * stored. Without D, 458 items are indistinguishable from another item by
   * their structured fields: an ISA 75x75x8, a 100x75x8 and a 125x75x8 all read
   * `t=8, w=75`. Backfilled from the SHEET rather than parsed back out of the
   * name — the source still exists, and re-deriving data from a label we
   * generated ourselves is how a rounding error becomes permanent.
   */
  const [[depthField]] = await conn.query(
    'SELECT id FROM fab_fields WHERE company_id = ? AND field_key = ? LIMIT 1', [companyId, 'depth_mm'],
  );
  let depthId = depthField?.id ?? null;
  if (!depthId) {
    did.push("field 'depth_mm' created (number, mm, @ order_item)");
    if (apply) {
      const [ins] = await conn.query(
        `INSERT INTO fab_fields
           (company_id, field_key, label, data_type, dimension, default_unit, applies_at,
            formula_usable, is_standard, sort_order, active)
         VALUES (?, 'depth_mm', 'Section depth', 'number', 'length', 'mm', 'order_item', 1, 1, 202, 1)`,
        [companyId],
      );
      depthId = ins.insertId;
    }
  }
  const [profItems] = await conn.query(
    `SELECT ic.id, ic.code FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name IN ('Angles','Beams','Channels')
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL`,
    [companyId],
  );
  const depthRows = [];
  for (const p of profItems) {
    const d = sheet.get(p.code)?.depth;
    if (d != null) depthRows.push([companyId, depthId, 'catalog_item', p.id, d, 'mm']);
  }
  did.push(`depth_mm backfilled on ${depthRows.length} profile(s) from the sheet's Depth column`);
  if (apply && depthRows.length) {
    for (const g of chunk(profItems.map((p) => p.id), 500)) {
      await conn.query(
        `UPDATE fab_field_values SET deleted_at = NOW()
          WHERE company_id = ? AND field_id = ? AND scope = 'catalog_item' AND scope_id IN (?)
            AND deleted_at IS NULL`,
        [companyId, depthId, g],
      );
    }
    for (const g of chunk(depthRows, 900)) {
      await conn.query(
        'INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_num, unit_code) VALUES ?',
        [g],
      );
    }
  }

  /**
   * 5. The legacy plates have NO grade value at all.
   *
   * This is the operative defect, not the B0/BO spelling: the suggestor groups
   * parts by thickness AND grade and matches candidates on both, so a part cut
   * from a legacy plate can never match anything. Their names say E350 B0 with
   * a zero; the 1,410 newer values all use the letter O. One vocabulary or the
   * grade key silently partitions the catalogue in two.
   */
  const [[gradeField]] = await conn.query(
    'SELECT id FROM fab_fields WHERE company_id = ? AND field_key = ? LIMIT 1', [companyId, 'grade'],
  );
  const [legacy] = await conn.query(
    `SELECT ic.id, ic.code, ic.name FROM fab_item_catalog ic
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.code LIKE 'RM26%'
        AND ic.name REGEXP 'E[0-9]+ B'
        AND NOT EXISTS (SELECT 1 FROM fab_field_values v WHERE v.scope='catalog_item'
                         AND v.scope_id = ic.id AND v.field_id = ? AND v.deleted_at IS NULL)`,
    [companyId, gradeField.id],
  );
  const gradeRows = [];
  const renames = [];
  for (const l of legacy) {
    const m = /(E\d+)\s*B[0O]/i.exec(l.name);
    if (!m) continue;
    gradeRows.push([companyId, gradeField.id, 'catalog_item', l.id, `${m[1].toUpperCase()} BO`]);
    if (/B0/.test(l.name)) renames.push([l.id, l.name.replace(/B0\b/g, 'BO')]);
  }
  did.push(`grade value added to ${gradeRows.length} legacy item(s); ${renames.length} name(s) B0 -> BO`);
  if (apply) {
    for (const g of chunk(gradeRows, 900)) {
      await conn.query(
        'INSERT INTO fab_field_values (company_id, field_id, scope, scope_id, value_text) VALUES ?', [g],
      );
    }
    for (const [id, name] of renames) {
      await conn.query('UPDATE fab_item_catalog SET name = ? WHERE id = ?', [name, id]);
    }
  }

  /** 6. A shear stud is a fastener, and is currently offered as plate to cut from. */
  const [[fastCat]] = await conn.query(
    `SELECT id FROM fab_item_categories WHERE company_id = ? AND deleted_at IS NULL
       AND name LIKE '%Fasteners%' LIMIT 1`,
    [companyId],
  );
  const [studs] = await conn.query(
    `SELECT ic.id, ic.code FROM fab_item_catalog ic
       JOIN fab_item_categories c ON c.id = ic.category_id AND c.name = 'Raw Materials'
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.name LIKE '%Stud%'`,
    [companyId],
  );
  if (fastCat && studs.length) {
    did.push(`${studs.length} fastener(s) moved to Fasteners & Hardware: ${studs.map((s) => s.code).join(', ')}`);
    if (apply) {
      await conn.query(
        'UPDATE fab_item_catalog SET category_id = ?, group_id = NULL, subgroup_id = NULL WHERE id IN (?)',
        [fastCat.id, studs.map((s) => s.id)],
      );
    }
  }

  /** 7. A unit code that is not in fab_units cannot convert. */
  const [bad] = await conn.query(
    `SELECT ic.id, ic.code FROM fab_item_catalog ic
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.unit IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fab_units u WHERE u.code = ic.unit)`,
    [companyId],
  );
  did.push(`${bad.length} item(s) with a unit code not in fab_units: ${bad.map((b) => b.code).join(', ') || 'none'}`);
  if (apply && bad.length) {
    await conn.query("UPDATE fab_item_catalog SET unit = 'litre' WHERE id IN (?) AND unit = 'L'",
      [bad.map((b) => b.id)]);
  }

  // ── what is deliberately NOT fixed ────────────────────────────────────────
  const [noArea] = await conn.query(
    `SELECT COUNT(*) n FROM fab_item_catalog ic
       JOIN fab_item_groups g ON g.id = ic.group_id AND g.name IN ('Beams','Channels')
      WHERE ic.company_id = ? AND ic.deleted_at IS NULL AND ic.section_area_mm2 IS NULL`,
    [companyId],
  );
  left.push(`${noArea[0].n} beam/channel item(s) still have no section_area_mm2 — needs the flange `
    + 'thickness (an IS 808 table), which this workbook does not carry. Their weights use the '
    + 'flat-plate fallback and are badly light until then.');
  left.push('The 11 legacy RM26* items still anchor 1,082 BOM rows and 155 stock pieces. They are '
    + 'thickness-level; the new catalogue is per-size. Repointing them is a data migration, not a fix.');

  log(`\ncatalog repair — company ${companyId}`);
  for (const d of did) log(`  ${d}`);
  log('\n  left alone, on purpose:');
  for (const l of left) log(`   - ${l}`);

  if (!apply) { await conn.rollback(); log('\nNothing written. Re-run with --apply.\n'); }
  else { await conn.commit(); log(`\n  committed (${areaSet} section areas written)\n`); }
} catch (err) {
  await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}`);
  console.error(err.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
