/**
 * scope-fields.mjs — stop every field appearing on every item.
 *
 * WHAT LIMITS THIS. `fab_fields` scopes with THREE single-valued columns —
 * category_id, group_id, subgroup_id — so a field belongs to at most one
 * category. Most of the useful answers are two or more: `grade` is meaningful on
 * fabricated steel AND on raw material, `lead_time_days` on everything bought.
 * Those stay unscoped, because "applies to several categories" is honestly
 * expressed as global, and a wrong single category would hide the field exactly
 * where somebody needs it. Only the unambiguous ones are narrowed here.
 *
 * PART vs ASSEMBLY becomes a SUBGROUP, and only in the catalog. It stays derived
 * on order items, where the tree moves and a stored flag drifts — but a catalog
 * Top Flange is never going to grow a BOM, so recording it there is stable. It
 * is what lets `num_holes` sit on parts and `weld_length_m` on assemblies.
 *
 *   node scripts/scope-fields.mjs            # report
 *   node scripts/scope-fields.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const COMPANY = 30005;

/** The typo, as a string the SQL below can carry safely. */
const MS_TYPO = `MS${String.fromCharCode(96)}`;

/**
 * A subgroup code inside the column's twenty characters.
 *
 * The group's initials plus the subgroup — CG-PARTS, OG-ASSY — because
 * "composite-girder-parts" is twenty-two and the insert simply fails.
 */
const subCode = (groupName, name) => {
  const initials = String(groupName).split(/\s+/).map((w) => w[0]).join('').toUpperCase();
  return `${initials}-${name === 'Assemblies' ? 'ASSY' : 'PARTS'}`.slice(0, 20);
};

/** field -> where it honestly belongs. Category only, because that is all a field holds. */
const SCOPE = {
  // Bought steel, not anything made from it.
  density_kg_m3: { category: 'Raw Materials' },
  material_form: { category: 'Raw Materials' },
  section_area_mm2: { category: 'Raw Materials' },
  depth_mm: { category: 'Raw Materials' },
  mill_cert_ref: { category: 'Raw Materials' },
  // Made, not bought.
  surface_area_m2: { category: 'Fabricated' },
  drawing_ref: { category: 'Fabricated' },
  edge_length_m: { category: 'Fabricated', subgroup: 'Parts' },
  num_holes: { category: 'Fabricated', subgroup: 'Parts' },
  weld_length_m: { category: 'Fabricated', subgroup: 'Assemblies' },
  span_ref: { category: 'Fabricated', subgroup: 'Assemblies' },
  sell_rate_per_kg: { category: 'Fabricated', subgroup: 'Assemblies' },
  // A machine is not steel.
  model: { category: 'Machines & Equipment' },
  power_kw: { category: 'Machines & Equipment' },
  max_thickness_mm: { category: 'Machines & Equipment' },
  // Things that go off.
  shelf_life_days: { category: 'Consumables' },
  expiry_date: { category: 'Consumables' },
};

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  // ── 1. the typo ──────────────────────────────────────────────────────────
  const [[bad]] = await conn.query(
    `SELECT COUNT(*) n FROM fab_field_values fv JOIN fab_fields ff ON ff.id = fv.field_id
      WHERE fv.company_id = ? AND ff.field_key = 'material'
        AND fv.value_text = ? AND fv.deleted_at IS NULL`,
    [COMPANY, MS_TYPO],
  );
  console.log(`material values with a stray backtick: ${bad.n}`);
  if (APPLY && bad.n) {
    await conn.query(
      `UPDATE fab_field_values fv JOIN fab_fields ff ON ff.id = fv.field_id
          SET fv.value_text = 'MS'
        WHERE fv.company_id = ? AND ff.field_key = 'material'
          AND fv.value_text = ? AND fv.deleted_at IS NULL`,
      [COMPANY, MS_TYPO],
    );
  }

  // ── 2. Parts / Assemblies under every Fabricated group ───────────────────
  const [groups] = await conn.query(
    `SELECT g.id, g.name FROM fab_item_groups g
       JOIN fab_item_categories c ON c.id = g.category_id
      WHERE g.company_id = ? AND c.name = 'Fabricated' AND g.deleted_at IS NULL`,
    [COMPANY],
  );
  const subId = new Map();
  for (const g of groups) {
    for (const name of ['Parts', 'Assemblies']) {
      const [[s]] = await conn.query(
        `SELECT id FROM fab_item_subgroups
          WHERE company_id = ? AND group_id = ? AND name = ? AND deleted_at IS NULL`,
        [COMPANY, g.id, name],
      );
      if (s) { subId.set(`${g.id}|${name}`, s.id); continue; }
      if (!APPLY) { console.log(`subgroup "${g.name} > ${name}": would create`); continue; }
      const [r] = await conn.query(
        `INSERT INTO fab_item_subgroups (company_id, group_id, code, name, created_at)
         VALUES (?,?,?,?,NOW())`,
        [COMPANY, g.id, subCode(g.name, name), name],
      );
      subId.set(`${g.id}|${name}`, r.insertId);
    }
  }

  // ── 3. file each item by whether it has a BOM ────────────────────────────
  const [items] = await conn.query(
    `SELECT i.id, i.group_id AS gid,
            (SELECT COUNT(*) FROM fab_item_bom b
              WHERE b.parent_item_id = i.id AND b.deleted_at IS NULL AND b.active = 1) AS bom
       FROM fab_item_catalog i JOIN fab_item_categories c ON c.id = i.category_id
      WHERE i.company_id = ? AND c.name = 'Fabricated' AND i.deleted_at IS NULL`,
    [COMPANY],
  );
  let filed = 0;
  for (const i of items) {
    const sid = subId.get(`${i.gid}|${Number(i.bom) > 0 ? 'Assemblies' : 'Parts'}`);
    if (!sid) continue;
    if (APPLY) {
      await conn.query('UPDATE fab_item_catalog SET subgroup_id = ? WHERE id = ? AND company_id = ?',
        [sid, i.id, COMPANY]);
    }
    filed++;
  }
  console.log(`items filed Parts/Assemblies: ${filed} of ${items.length}`);

  // ── 4. narrow the fields with one honest home ────────────────────────────
  const [cats] = await conn.query(
    'SELECT id, name FROM fab_item_categories WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const catId = new Map(cats.map((c) => [c.name, c.id]));
  const [[total]] = await conn.query(
    'SELECT COUNT(*) n FROM fab_fields WHERE company_id = ? AND deleted_at IS NULL AND active = 1', [COMPANY]);

  const report = [];
  for (const [key, s] of Object.entries(SCOPE)) {
    const cid = catId.get(s.category);
    if (!cid) { report.push({ field: key, scopedTo: `MISSING CATEGORY: ${s.category}` }); continue; }
    /*
     * A subgroup NAME repeats under all five structure groups and a field holds
     * one id, so a subgroup-scoped field reaches one group's Parts only. Left
     * at the category with a note rather than pretending otherwise — narrowing
     * to one structure type would hide the field on the other four.
     */
    report.push({
      field: key,
      scopedTo: s.category,
      note: s.subgroup ? `wants ${s.subgroup} — one id cannot span 5 groups` : '',
    });
    if (APPLY) {
      await conn.query(
        `UPDATE fab_fields SET category_id = ?, group_id = NULL, subgroup_id = NULL
          WHERE company_id = ? AND field_key = ? AND deleted_at IS NULL`,
        [cid, COMPANY, key],
      );
    }
  }
  console.table(report);
  console.log(`${Object.keys(SCOPE).length} narrowed, ${Number(total.n) - Object.keys(SCOPE).length} left global`);

  if (!APPLY) console.log('\nDRY RUN — pass --apply.');
  else { await conn.commit(); console.log('committed'); }
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally { conn.release(); await pool.end(); }
