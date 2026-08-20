/**
 * 02-materials.mjs — taxonomy, raw materials, consumables, spares.
 *
 * Everything a job CONSUMES. What a job produces is module 03's problem, and
 * the machines that do the consuming are module 04's.
 *
 * THREE THINGS HERE ARE EASY TO GET SUBTLY WRONG, so they are worth stating
 * before the code says them.
 *
 * 1. THE TAXONOMY IS PART-SEEDED ALREADY. init.sql cross-joins eight categories
 *    and twenty-seven groups onto EVERY company, so Raw Materials/Metals,
 *    Consumables/{Welding Consumables, Abrasives}, MRO & Spares/Machine Spares
 *    and Finished Goods/Products all exist before this runs. Only Coatings and
 *    Tooling are genuinely new. Inserting the rest again would not even fail
 *    loudly — `uq_fig_category_name_active` would reject it, and a rebuild that
 *    dies on its own second statement is not a rebuild.
 *
 * 2. FIELD VALUES GO THROUGH `setFields`, NEVER STRAIGHT INTO
 *    `fab_field_values`. Three of the keys written here — thickness_mm,
 *    density_kg_m3, section_area_mm2 — are ALSO columns on fab_item_catalog,
 *    and those columns are what nesting and the material picker actually filter
 *    on (`rawMaterialService`, `idx_fic_form_thickness`). `setFields` writes the
 *    value and projects the column in one transaction; writing the row by hand
 *    leaves the column NULL, and a NULL there does not error — it just means no
 *    plate ever matches a thickness, so procurement declines every order.
 *    That is the exact failure the old tenant shipped with.
 *
 * 3. CODES ARE MINTED, NOT TYPED. The company keeps a live `item` rule in
 *    fab_codegen_rules (category shortform + running sequence), and its
 *    `next_seq` is shared with every code the app issues afterwards. Writing
 *    codes by hand here would not advance that counter, so the first item
 *    created through the UI would collide with one of ours. `generateCode` is
 *    handed the runner's connection so the number and the row it names commit
 *    or roll back together.
 *
 * NOTE ON WHAT IS NOT MODELLED. A spare is "tied to" the machine that eats it
 * only in its `description`: there is no link table between fab_item_catalog
 * and fab_resource_types, and inventing one is not this module's job.
 */

import { generateCode } from '../../apps/fab_erp/services/codegenService.js';
import { setFields } from '../../apps/fab_erp/services/fieldService.js';
import { PROJECTIONS } from '../../apps/fab_erp/services/fieldProjection.js';

export const NAME = 'Materials';

/** Category code -> display name. All eight are init.sql's; these are the four used. */
/**
 * `mach` is here for a reason that is easy to miss.
 *
 * On a tenant that init.sql has seeded it already exists, so this list looked
 * complete. On a WIPED tenant it does not, and nothing else recreates it —
 * init.sql seeds it, but re-running init.sql after this seed would drag
 * `fab_fields` back through its `fab_field_defs` carry-over and re-map
 * `thickness_mm` to `applies_at='stock_piece'`, undoing module 01. So the
 * category has to be created here.
 *
 * Without it the `machines` item scope has no category to include and is
 * skipped, which quietly removes the "buy a new machine" pick list, and machine
 * assets have nowhere to hold a catalog identity.
 */
const CATEGORIES = [
  { code: 'rm',   name: 'Raw Materials' },
  { code: 'cons', name: 'Consumables' },
  { code: 'mro',  name: 'MRO & Spares' },
  { code: 'fg',   name: 'Finished Goods' },
  { code: 'mach', name: 'Machines & Equipment' },
];

/**
 * The required end state. `met`, `weld`, `abr`, `mspr` and `prod` are already
 * seeded by init.sql; `coat` and `tool` are the two this adds.
 *
 * `tool` as a group code under `mro` does not clash with the `tool` CATEGORY
 * (Tools & Tooling) — different table, and the group's unique key is
 * (company_id, category_id, code).
 */
const GROUPS = [
  { cat: 'rm',   code: 'met',  name: 'Metals' },
  { cat: 'cons', code: 'weld', name: 'Welding Consumables' },
  { cat: 'cons', code: 'abr',  name: 'Abrasives' },
  { cat: 'cons', code: 'coat', name: 'Coatings' },
  { cat: 'mro',  code: 'mspr', name: 'Machine Spares' },
  { cat: 'mro',  code: 'tool', name: 'Tooling' },
  { cat: 'fg',   code: 'prod', name: 'Products' },
];

const STEEL_DENSITY = 7850;

/**
 * `material_form` is what `rawMaterialService` splits on: a plate is matched by
 * thickness and nested, a section is matched whole. Getting it wrong makes a
 * channel look like something you could nest parts out of.
 */
const plate = (mm) => ({
  name: `MS Plate ${mm}mm E350 B0`,
  cat: 'rm', group: 'met', unit: 'pcs', proc: 'buy', mrp: 'lot_for_lot',
  form: 'plate',
  description: `IS 2062 E350 B0 mild steel plate, ${mm} mm thick`,
  fields: { thickness_mm: mm, density_kg_m3: STEEL_DENSITY },
});

/**
 * RAW MATERIALS — 8.
 *
 * Six plates and two sections, names carried over verbatim from the old tenant
 * so anything that referenced them by name still reads.
 *
 * `unit` is pcs, not the old tenant's kg. A plate is drawn from stock as one
 * physical piece exactly once — that is the whole premise of the nesting model
 * — and stocking it by weight is what let 173 unsized pieces exist. Weight is
 * derived (volume x density) rather than stocked.
 *
 * WHY `section_area_mm2` ON THE SECTIONS AND NOT THE PLATES. For a plate the
 * cross-section is thickness x width and the nester already knows both. For a
 * rolled section it is neither: an ISA 100x100x10 computed as 100 x 10 comes
 * out ~47% light, because the two legs overlap at the root and the toes are
 * radiused. So the section carries its handbook area and the weight formula
 * uses that instead.
 *
 * THE EIGHTH ITEM is ISMC 200 — see the report. Its `thickness_mm` is the WEB
 * thickness (6.1), which is the same convention the old ISA row used (10 = leg
 * thickness): the governing plate thickness of the profile, which is what edge
 * prep and welding formulas want.
 */
const RAW_MATERIALS = [
  // 12 and 25 come from the KEPL ROB BOQ — its stiffeners are 12 mm and its
  // top flanges and splice plates 25 mm, neither of which the old tenant stocked.
  plate(12), plate(16), plate(20), plate(25), plate(28), plate(32), plate(40), plate(45),
  {
    name: 'ISA 100x100x10 E350 B0',
    cat: 'rm', group: 'met', unit: 'pcs', proc: 'buy', mrp: 'lot_for_lot',
    form: 'section',
    description: 'IS 808 equal angle 100 x 100 x 10, E350 B0 — cross-frame and bracing member',
    // 1898.089 mm2 is the figure the old tenant carried; kept rather than
    // rounded to the handbook 1903, so nothing that compared against it moves.
    fields: { thickness_mm: 10, density_kg_m3: STEEL_DENSITY, section_area_mm2: 1898.089 },
  },
  {
    name: 'ISMC 200 E350 B0',
    cat: 'rm', group: 'met', unit: 'pcs', proc: 'buy', mrp: 'lot_for_lot',
    form: 'section',
    description: 'IS 808 medium channel 200 x 75, E350 B0 — cross-frame / diaphragm member between girders',
    // 2821 mm2 is the IS 808 sectional area for ISMC 200 (22.1 kg/m at 7850,
    // which is the handbook mass — the two agree, which is the check).
    fields: { thickness_mm: 6.1, density_kg_m3: STEEL_DENSITY, section_area_mm2: 2821 },
  },
];

/**
 * CONSUMABLES — 5. Exactly what the flows in module 04 burn: SAW wire and flux
 * for the welding stations, zinc wire for metalizing, grit for the blast
 * cabinet, paint for the paint bay.
 *
 * `L` for paint matches the old tenant's row. It is NOT a `fab_units` code
 * (that would be `litre`) — but `fab_item_catalog.unit` is free text and is not
 * validated against fab_units, so matching the old data wins over inventing a
 * new spelling. Flagged in the report.
 */
const CONSUMABLES = [
  { name: 'SAW Welding Wire',           cat: 'cons', group: 'weld', unit: 'kg', proc: 'buy', mrp: 'lot_for_lot', description: 'Submerged-arc welding wire — SAW Welding stations' },
  { name: 'SAW Welding Flux',           cat: 'cons', group: 'weld', unit: 'kg', proc: 'buy', mrp: 'lot_for_lot', description: 'Submerged-arc welding flux — SAW Welding stations' },
  { name: 'Zinc Wire (Metalizing)',     cat: 'cons', group: 'weld', unit: 'kg', proc: 'buy', mrp: 'lot_for_lot', description: 'Zinc spray wire — Metalizing booths' },
  { name: 'Steel Grit Abrasive',        cat: 'cons', group: 'abr',  unit: 'kg', proc: 'buy', mrp: 'lot_for_lot', description: 'Blast media — Shot Blasting' },
  { name: 'Structural Paint (Epoxy/PU)', cat: 'cons', group: 'coat', unit: 'L', proc: 'buy', mrp: 'lot_for_lot', description: 'Epoxy primer / PU top coat — Painting booths' },
];

/**
 * SPARES — 8, all new. `reorder_point` rather than `lot_for_lot`: a spare has
 * no order to be netted against, so lot-for-lot would generate demand for it
 * exactly never. Reorder point is what makes one appear on the buy list when
 * the shelf empties.
 *
 * THE SPLIT. Tooling is what touches and shapes the work and wears at its
 * cutting edge; Machine Spares are replaceable components of the machine
 * itself. That line puts drill bits and cutting consumables in Tooling and
 * torch tips, nozzles and rope in Machine Spares.
 */
const SPARES = [
  { name: 'CNC Cutting Nozzle',    cat: 'mro', group: 'tool', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: CNC Plate Cutting' },
  { name: 'CNC Cutting Electrode', cat: 'mro', group: 'tool', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: CNC Plate Cutting' },
  { name: 'Drill Bit 20 mm',       cat: 'mro', group: 'tool', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: CNC Drilling' },
  { name: 'Drill Bit 24 mm',       cat: 'mro', group: 'tool', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: CNC Drilling' },
  { name: 'SAW Contact Tip',       cat: 'mro', group: 'mspr', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: SAW Welding' },
  { name: 'Blast Nozzle',          cat: 'mro', group: 'mspr', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: Shot Blasting' },
  { name: 'Crane Wire Rope',       cat: 'mro', group: 'mspr', unit: 'm',   proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: Crane / EOT Crane' },
  { name: 'Paint Spray Tip',       cat: 'mro', group: 'mspr', unit: 'nos', proc: 'buy', mrp: 'reorder_point', description: 'Consumed by: Painting' },
];

const ITEMS = [...RAW_MATERIALS, ...CONSUMABLES, ...SPARES];

/** Columns on fab_item_catalog this module owns; the rest is left alone. */
const MANAGED = ['category_id', 'group_id', 'unit', 'procurement_type', 'mrp_policy',
  'material_form', 'description'];

const same = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
};

/** DECIMAL round-trips, so compare numbers with a tolerance rather than ===. */
const sameNum = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-6;
};

export async function seed(ctx) {
  const { companyId, apply, conn, log } = ctx;

  const counts = { categories: 0, groups: 0, items: 0, updated: 0, fieldSets: 0, unchanged: 0 };

  // ---- 1. Categories ------------------------------------------------------
  const [catRows] = await conn.query(
    'SELECT id, code, name FROM fab_item_categories WHERE company_id = ? AND deleted_at IS NULL',
    [companyId],
  );
  const catId = new Map(catRows.map((r) => [r.code, r.id]));

  for (const c of CATEGORIES) {
    if (catId.has(c.code)) continue;
    counts.categories++;
    log(`+ category ${c.name} (${c.code})`);
    if (!apply) { catId.set(c.code, null); continue; }
    const [res] = await conn.query(
      `INSERT INTO fab_item_categories (company_id, name, code, shortform, description, is_system)
       VALUES (?, ?, ?, ?, NULL, 1)`,
      [companyId, c.name, c.code, c.code.slice(0, 10)],
    );
    catId.set(c.code, res.insertId);
  }

  // ---- 2. Groups ----------------------------------------------------------
  const [grpRows] = await conn.query(
    `SELECT g.id, g.code, c.code AS cat
       FROM fab_item_groups g
       JOIN fab_item_categories c ON c.id = g.category_id
      WHERE g.company_id = ? AND g.deleted_at IS NULL`,
    [companyId],
  );
  const grpId = new Map(grpRows.map((r) => [`${r.cat}/${r.code}`, r.id]));

  for (const g of GROUPS) {
    const key = `${g.cat}/${g.code}`;
    if (grpId.has(key)) continue;
    counts.groups++;
    log(`+ group ${g.name} under ${g.cat}`);
    if (!apply) { grpId.set(key, null); continue; }
    const parent = catId.get(g.cat);
    if (!parent) throw new Error(`Category "${g.cat}" is missing — cannot create group "${g.name}".`);
    const [res] = await conn.query(
      `INSERT INTO fab_item_groups (company_id, category_id, name, code, shortform, description, is_system)
       VALUES (?, ?, ?, ?, ?, NULL, 1)`,
      [companyId, parent, g.name, g.code, g.code.slice(0, 10)],
    );
    grpId.set(key, res.insertId);
  }

  // ---- 3. The field definitions the item values need ----------------------
  // setFields REJECTS a value whose field does not exist, and returns the
  // rejection rather than throwing — so a missing definition would show up as a
  // seed that "worked" and a nesting board that never matches. Check first.
  const wantedKeys = [...new Set(ITEMS.flatMap((i) => Object.keys(i.fields ?? {})))];
  const [defRows] = await conn.query(
    `SELECT field_key FROM fab_fields
      WHERE company_id = ? AND deleted_at IS NULL AND active = 1
        AND field_key IN (${wantedKeys.map(() => '?').join(',')})`,
    [companyId, ...wantedKeys],
  );
  const haveKeys = new Set(defRows.map((r) => r.field_key));
  const missingDefs = wantedKeys.filter((k) => !haveKeys.has(k));
  if (missingDefs.length) {
    throw new Error(
      `fab_fields is missing ${missingDefs.join(', ')} for company ${companyId}. `
      + 'Module 01-fields must run first — without the definition setFields silently '
      + 'rejects the value and the projected column stays NULL.',
    );
  }

  // ---- 4. Items -----------------------------------------------------------
  const projected = PROJECTIONS.catalog_item.columns; // fieldKey -> column name

  const [itemRows] = await conn.query(
    `SELECT id, name, code, category_id, group_id, unit, procurement_type, mrp_policy,
            material_form, description,
            ${Object.values(projected).map((c) => `\`${c}\``).join(', ')}
       FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  // NAME is the natural key here, and the database agrees: fab_item_catalog has
  // uq_fic2_company_name_active. `code` cannot be the key because the code is
  // minted on creation and is not knowable before the row exists.
  const byName = new Map(itemRows.map((r) => [r.name, r]));

  // Every value already sitting at catalog_item scope, so an item that is
  // already correct can be skipped rather than rewritten. Without this the
  // second run would report a pile of writes and prove nothing.
  const [valRows] = await conn.query(
    `SELECT v.scope_id, f.field_key, v.value_num
       FROM fab_field_values v
       JOIN fab_fields f ON f.id = v.field_id
      WHERE v.company_id = ? AND v.scope = 'catalog_item' AND v.deleted_at IS NULL`,
    [companyId],
  );
  const valueAt = new Map();
  for (const v of valRows) valueAt.set(`${v.scope_id}:${v.field_key}`, v.value_num);

  for (const spec of ITEMS) {
    const want = {
      category_id: catId.get(spec.cat) ?? null,
      group_id: spec.group ? (grpId.get(`${spec.cat}/${spec.group}`) ?? null) : null,
      unit: spec.unit,
      procurement_type: spec.proc,
      mrp_policy: spec.mrp,
      material_form: spec.form ?? null,
      description: spec.description ?? null,
    };
    const fields = spec.fields ?? {};
    let row = byName.get(spec.name);
    let itemId = row?.id ?? null;
    let touched = false;

    if (!row) {
      touched = true;
      counts.items++;
      if (!apply) {
        log(`+ item ${spec.name}  [${spec.cat}/${spec.group}]  (code minted on --apply)`);
        // Values would be written too — count them so the dry run reports the
        // real amount of work rather than a misleading zero.
        if (Object.keys(fields).length) counts.fieldSets++;
        continue;
      }
      const code = await generateCode(
        companyId, 'item',
        { categoryId: want.category_id, groupId: want.group_id, subgroupId: null },
        conn,
      );
      const [res] = await conn.query(
        `INSERT INTO fab_item_catalog
           (company_id, name, code, unit, description, category_id, group_id, subgroup_id,
            procurement_type, mrp_policy, material_form)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [companyId, spec.name, code, want.unit, want.description, want.category_id,
          want.group_id, want.procurement_type, want.mrp_policy, want.material_form],
      );
      itemId = res.insertId;
      log(`+ item ${code.padEnd(10)} ${spec.name}`);
      row = null; // freshly created: every field value below is new
    } else {
      const drift = MANAGED.filter((c) => !same(row[c], want[c]));
      if (drift.length) {
        counts.updated++;
        touched = true;
        log(`~ item ${row.code} ${spec.name}: ${drift.map((c) => `${c} ${row[c] ?? 'NULL'} -> ${want[c] ?? 'NULL'}`).join(', ')}`);
        if (apply) {
          await conn.query(
            `UPDATE fab_item_catalog
                SET category_id = ?, group_id = ?, unit = ?, procurement_type = ?,
                    mrp_policy = ?, material_form = ?, description = ?
              WHERE id = ? AND company_id = ?`,
            [want.category_id, want.group_id, want.unit, want.procurement_type,
              want.mrp_policy, want.material_form, want.description, row.id, companyId],
          );
        }
      }
    }

    if (!Object.keys(fields).length) { if (!touched) counts.unchanged++; continue; }

    /**
     * In sync only when BOTH halves agree: the value row AND the column it is
     * projected into. Checking only the value would leave a NULL column
     * unrepaired forever — and the NULL column is the half that nesting reads.
     */
    const inSync = row != null && Object.entries(fields).every(([key, v]) => {
      if (!sameNum(valueAt.get(`${itemId}:${key}`), v)) return false;
      const col = projected[key];
      return col ? sameNum(row[col], v) : true;
    });

    if (inSync) { if (!touched) counts.unchanged++; continue; }

    counts.fieldSets++;
    log(`  fields ${spec.name}: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (!apply) continue;

    const res = await setFields(companyId, 'catalog_item', itemId, fields, conn);
    if (res.rejected?.length) {
      // Rejections are returned, not thrown. Left unchecked they are invisible.
      throw new Error(
        `setFields rejected ${res.rejected.length} value(s) on "${spec.name}": `
        + res.rejected.map((r) => `${r.fieldKey} — ${r.why}`).join('; '),
      );
    }
  }

  return counts;
}
