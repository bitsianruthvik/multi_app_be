/**
 * import.mjs — load the customer's RM code master into the item catalog.
 *
 * Usage:
 *   node scripts/rm-master/import.mjs <companyId> [--forms=plate|all] [--apply]
 *   node scripts/rm-master/import.mjs 30005 --file="C:/path/Codes_Master_v7.xlsx"
 *
 * WHAT SHAPE, AND WHY. The sheet gives every SIZE its own code — RM00006 is
 * "MS PLATE 12 x 2300 x 2500 E350 BO" — so a size becomes a catalog item and
 * the taxonomy does the grouping the nester needs:
 *
 *   category   Raw Materials
 *   group      Plates            <- what the nester filters on
 *   subgroup   MS E350 BO        <- the material and grade
 *   item       RM00006           <- one buyable size
 *   fields     thickness_mm, width_mm, length_mm on the item
 *
 * That is what makes "every size I can buy in 12 mm E350" a single query
 * against a group and a field value, with nothing parsing an item's NAME to
 * work out what it is. It also needs no new table: the ladder already exists
 * and `thickness_mm` already projects onto fab_item_catalog.thickness_mm,
 * which the nesting checks read today.
 *
 * WHAT IT DOES NOT TRUST. The sheet calls all 1,104 angle rows "ISA - Equal
 * Angle" and 456 of them are unequal (30 x 20 x 3). Names here are built from
 * the DIMENSIONS and the sheet Description column is never imported, so the
 * wrong word cannot travel; the count is reported so the sheet gets fixed at
 * source. Column meaning also shifts per form — see FORMS.
 */

import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';

const args = process.argv.slice(2);
const companyId = Number(args.find((a) => /^\d+$/.test(a)));
const apply = args.includes('--apply');
const forms = (args.find((a) => a.startsWith('--forms='))?.split('=')[1]) ?? 'plate';
// No default path: the workbook lives wherever the person running this keeps
// it, and baking one machine's Downloads folder into a shared repo only ever
// works for the one who wrote it.
const file = args.find((a) => a.startsWith('--file='))?.split('=')[1] ?? process.env.RM_MASTER_FILE;

if (!companyId || !file) {
  console.error('Usage: node scripts/rm-master/import.mjs <companyId> --file=<Codes_Master.xlsx> '
    + '[--forms=plate|all] [--apply]');
  console.error('       (the workbook path may also come from RM_MASTER_FILE)');
  process.exit(1);
}

const NA = (v) => v === 'NA' || v == null || v === '';
const num = (v) => (NA(v) ? null : Number(v));
const log = (m) => console.log(m);

/**
 * How each material form reads its columns.
 *
 * The sheet reuses the same six columns to mean different things per form — for
 * a plate, Thickness is thickness; for an angle, Thickness is "NA" and the
 * thickness is in the WEB column while Width holds the second leg. Writing that
 * down per form is the only way the import is auditable; inferring it from
 * whichever column happens to be filled would work until it silently did not.
 */
const FORMS = {
  'MS PLATE': {
    group: 'Plates',
    materialForm: 'plate',
    // thickness x width x length
    dims: (r) => ({ thickness: num(r.thick), width: num(r.width), length: num(r.length) }),
    label: (r, d) => `MS Plate ${d.thickness} x ${d.width} x ${d.length} ${r.grade}`,
    material: () => 'MS',
  },
  'ISA - Equal Angle': {
    group: 'Angles',
    materialForm: 'angle',
    // depth = leg 1, width = leg 2, web = thickness, length = stock length
    dims: (r) => ({ thickness: num(r.web), width: num(r.width), length: num(r.length), depth: num(r.depth) }),
    label: (r, d) => `ISA ${d.depth} x ${d.width} x ${d.thickness} x ${d.length} ${r.grade}`,
    material: () => 'MS',
    // The sheet's own name is wrong for 456 of these; say which it really is.
    rename: (d) => (d.depth === d.width ? 'Equal Angle' : 'Unequal Angle'),
  },
};
const SECTION_FORMS = ['ISLB - Light Beam', 'ISMB - Medium Beam', 'Wide Flange', 'Channel',
  'ISHB - Heavy Beam', 'ISJB - Junior Beam', 'UB - Universal Beam'];
for (const f of SECTION_FORMS) {
  FORMS[f] = {
    group: f.includes('Channel') ? 'Channels' : 'Beams',
    materialForm: f.includes('Channel') ? 'channel' : 'beam',
    dims: (r) => ({ thickness: num(r.web), width: num(r.width), length: num(r.length), depth: num(r.depth) }),
    // A section is named by its designation. Where the sheet gives a web
    // thickness that is the third term; where it gives a linear weight instead
    // (Universal Beams) the designation IS depth x width x kg/m, so say kg/m
    // rather than printing a dash where a millimetre is expected.
    label: (r, d) => {
      const third = d.thickness != null ? `${d.thickness}`
        : num(r.linWeight) != null ? `${num(r.linWeight)} kg/m`
          : '?';
      return `${f.split(' - ')[0]} ${d.depth} x ${d.width} x ${third} x ${d.length} ${r.grade}`;
    },
    material: () => 'MS',
  };
}

// ── read the sheet ──────────────────────────────────────────────────────────
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.getWorksheet('RM_Master');
if (!ws) throw new Error('No RM_Master sheet in that workbook');

const rows = [];
ws.eachRow((r, i) => {
  if (i === 1) return;
  const v = r.values;
  rows.push({
    desc: v[2], depth: v[3], thick: v[4], width: v[5], length: v[6],
    web: v[7], linWeight: v[8], grade: v[9], uniq: v[10], code: v[11],
  });
});

const wanted = forms === 'all' ? Object.keys(FORMS) : ['MS PLATE'];
const selected = rows.filter((r) => wanted.includes(r.desc));
const unknown = [...new Set(rows.map((r) => r.desc))].filter((d) => !FORMS[d]);
if (unknown.length) log(`  NOTE: no column mapping for ${unknown.join(', ')} — those rows are skipped`);

// ── shape them ──────────────────────────────────────────────────────────────
const planned = [];
const relabelled = [];
const rejected = [];
for (const r of selected) {
  const spec = FORMS[r.desc];
  const d = spec.dims(r);
  /**
   * A PLATE WITHOUT A THICKNESS IS UNUSABLE; A BEAM WITHOUT ONE IS ORDINARY.
   *
   * Thickness is the whole basis of plate nesting, so a plate missing it is
   * rejected. A section is bought by its designation — `UB 203 x 133 x 30` is
   * 203 deep, 133 wide and 30 kg/m, and the sheet gives its linear weight where
   * other forms give a web thickness. Requiring one cost two real, buyable
   * items for a number that section nesting never asks for.
   */
  const needsThickness = spec.materialForm === 'plate';
  if (d.width == null || d.length == null || (needsThickness && d.thickness == null)) {
    rejected.push({ code: r.code, uniq: r.uniq, why: 'a dimension needed for this form is missing or NA' });
    continue;
  }
  const trueForm = spec.rename ? spec.rename(d) : null;
  if (trueForm && !r.desc.includes(trueForm)) relabelled.push({ code: r.code, from: r.desc, to: trueForm });
  planned.push({
    code: String(r.code).trim(),
    name: spec.label(r, d),
    description: r.uniq,
    group: spec.group,
    subgroup: `${spec.material(r)} ${r.grade}`,
    materialForm: spec.materialForm,
    thickness: d.thickness,
    width: d.width,
    length: d.length,
    grade: r.grade,
  });
}

const groups = [...new Set(planned.map((p) => p.group))];
const subgroups = [...new Set(planned.map((p) => `${p.group}|${p.subgroup}`))];

log(`\nRM master — ${file.split(/[\\/]/).pop()}`);
log(`  sheet rows ${rows.length}, selected ${selected.length} (${wanted.join(', ')})`);
log(`  -> ${planned.length} catalog items in ${groups.length} group(s), ${subgroups.length} subgroup(s)`);
for (const g of groups) {
  const inG = planned.filter((p) => p.group === g);
  const th = [...new Set(inG.map((p) => p.thickness))].filter((t) => t != null).sort((a, b) => a - b);
  const noTh = inG.filter((p) => p.thickness == null).length;
  log(`     ${g.padEnd(10)} ${String(inG.length).padStart(5)} items, ${th.length} thickness(es): `
    + `${th.slice(0, 14).join(', ')}${th.length > 14 ? ' …' : ''}`
    + (noTh ? `  (+${noTh} sized by linear weight)` : ''));
}
for (const s of subgroups) log(`     subgroup  ${s.replace('|', ' / ')}`);
if (relabelled.length) {
  // Stated as an observation, not a claim to have fixed something: the item's
  // name here is built from its DIMENSIONS, and the sheet's Description column
  // is never imported — so the wrong word is not carried in either way. Worth
  // reporting because the sheet itself should be corrected at source.
  log(`  NOTE: ${relabelled.length} row(s) are labelled "${relabelled[0].from}" in the sheet `
    + `but are ${relabelled[0].to.toLowerCase()}s (e.g. ${relabelled[0].code}).`);
  log('        Names here are derived from dimensions, so the wrong label is not imported.');
}
if (rejected.length) {
  log(`  REJECTED ${rejected.length} row(s) with an unusable dimension:`);
  for (const x of rejected.slice(0, 5)) log(`     ${x.code} ${x.uniq} — ${x.why}`);
}

if (!apply) { log('\nNothing written. Re-run with --apply.\n'); await pool.end(); process.exit(0); }

// ── write ───────────────────────────────────────────────────────────────────
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [[category]] = await conn.query(
    `SELECT id FROM fab_item_categories WHERE company_id = ? AND name = 'Raw Materials'
       AND deleted_at IS NULL LIMIT 1`,
    [companyId],
  );
  if (!category) throw new Error('No "Raw Materials" category on this company');

  const groupId = new Map();
  for (const g of groups) {
    const [[found]] = await conn.query(
      `SELECT id FROM fab_item_groups WHERE company_id = ? AND category_id = ? AND name = ?
         AND deleted_at IS NULL LIMIT 1`,
      [companyId, category.id, g],
    );
    if (found) { groupId.set(g, found.id); continue; }
    const [ins] = await conn.query(
      'INSERT INTO fab_item_groups (company_id, category_id, name, code) VALUES (?,?,?,?)',
      [companyId, category.id, g, g.slice(0, 4).toLowerCase()],
    );
    groupId.set(g, ins.insertId);
  }

  const subgroupId = new Map();
  for (const key of subgroups) {
    const [g, s] = key.split('|');
    const gid = groupId.get(g);
    const [[found]] = await conn.query(
      `SELECT id FROM fab_item_subgroups WHERE company_id = ? AND group_id = ? AND name = ?
         AND deleted_at IS NULL LIMIT 1`,
      [companyId, gid, s],
    );
    if (found) { subgroupId.set(key, found.id); continue; }
    const [ins] = await conn.query(
      'INSERT INTO fab_item_subgroups (company_id, group_id, name, code) VALUES (?,?,?,?)',
      [companyId, gid, s, s.replace(/\s+/g, '').slice(0, 12).toUpperCase()],
    );
    subgroupId.set(key, ins.insertId);
  }
  log(`  taxonomy: ${groupId.size} group(s), ${subgroupId.size} subgroup(s) ready`);

  // Existing items by code, so a re-run updates rather than duplicating.
  const [existing] = await conn.query(
    'SELECT id, code FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)',
    [companyId, planned.map((p) => p.code)],
  );
  const idByCode = new Map(existing.map((e) => [e.code, e.id]));

  let created = 0; let updated = 0;
  for (const p of planned) {
    const gid = groupId.get(p.group);
    const sid = subgroupId.get(`${p.group}|${p.subgroup}`);
    if (idByCode.has(p.code)) {
      await conn.query(
        `UPDATE fab_item_catalog
            SET name = ?, description = ?, category_id = ?, group_id = ?, subgroup_id = ?,
                material_form = ?, procurement_type = 'buy', unit = 'nos', density_kg_m3 = 7850
          WHERE id = ? AND company_id = ?`,
        [p.name, p.description, category.id, gid, sid, p.materialForm, idByCode.get(p.code), companyId],
      );
      updated++;
    } else {
      const [ins] = await conn.query(
        `INSERT INTO fab_item_catalog
           (company_id, code, name, description, category_id, group_id, subgroup_id,
            material_form, procurement_type, mrp_policy, unit, density_kg_m3)
         VALUES (?,?,?,?,?,?,?,?, 'buy', 'lot_for_lot', 'nos', 7850)`,
        [companyId, p.code, p.name, p.description, category.id, gid, sid, p.materialForm],
      );
      idByCode.set(p.code, ins.insertId);
      created++;
    }
  }
  log(`  catalog: ${created} created, ${updated} updated`);

  /**
   * The dimensions, through setFields rather than straight into the columns.
   *
   * setFields is what writes the value AND its projection together —
   * thickness_mm has a column behind it on fab_item_catalog and width/length do
   * not, and only setFields knows which. Writing fab_field_values directly here
   * would leave thickness_mm NULL in the column the nesting checks read, which
   * is the exact failure this codebase has already been bitten by once.
   */
  let written = 0;
  for (const p of planned) {
    const res = await setFields(companyId, 'catalog_item', idByCode.get(p.code), {
      thickness_mm: p.thickness,
      width_mm: p.width,
      length_mm: p.length,
    }, conn);
    if (res?.rejected?.length) {
      throw new Error(`${p.code}: ${res.rejected.map((r) => `${r.fieldKey} — ${r.why}`).join('; ')}`);
    }
    written += res?.written ?? 0;
  }
  log(`  field values: ${written}`);

  await conn.commit();
  log('  committed\n');
} catch (err) {
  await conn.rollback();
  console.error(`\nRolled back — nothing written: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
