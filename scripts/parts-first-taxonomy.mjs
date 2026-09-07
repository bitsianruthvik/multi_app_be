/**
 * parts-first-taxonomy.mjs — put the level that fields need where fields can reach it.
 *
 * ── WHY THE TWO LEVELS SWAP ───────────────────────────────────────────────
 * `edge_length_m` belongs on parts and `weld_length_m` on assemblies, and a
 * field scopes through one category id, one group id and one subgroup id. With
 * the structure type as the GROUP, "Parts" was a subgroup repeated under all
 * five — so scoping a field to Parts reached Composite Girder's and hid it from
 * the other four. A field cannot be scoped per item either: `fab_fields` has no
 * item column. And one shared Parts subgroup is impossible, because
 * `fab_item_subgroups.group_id` is NOT NULL.
 *
 * Swapping them makes the thing fields need addressable and loses nothing:
 *
 *   before   Fabricated > Composite Girder > Parts
 *   after    Fabricated > Parts            > Composite Girder
 *
 * A field now scopes to `Parts` and reaches all sixty-one of them. Which
 * structure a part belongs to survives one level down, so nothing is forgotten —
 * it is the same three facts in the order that makes them usable.
 *
 * ── STOCK PIECES STOP CARRYING THEIR OWN SIZE ─────────────────────────────
 * The model changed: standard lengths and widths are separate catalog items now,
 * so nesting can choose between them. A piece therefore IS its item's size and
 * has nothing of its own to record. `applies_at` is the narrowest rung a value
 * may be set on — enforced on write — so moving length and width to `order_item`
 * refuses a stock-piece value rather than letting one drift back in.
 *
 * The 209 pieces are cleared with it. None of them is real stock.
 *
 *   node scripts/parts-first-taxonomy.mjs            # report
 *   node scripts/parts-first-taxonomy.mjs --apply
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

/** Fields that belong to one side of the parts/assemblies split. */
const BY_GROUP = {
  Parts: ['edge_length_m', 'num_holes'],
  Assemblies: ['weld_length_m', 'span_ref', 'sell_rate_per_kg'],
};

const short = (s) => String(s).split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 8);

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [[cat]] = await conn.query(
    "SELECT id FROM fab_item_categories WHERE company_id=? AND name='Fabricated' AND deleted_at IS NULL",
    [COMPANY]);
  if (!cat) throw new Error('category "Fabricated" not found — run clean-catalog-taxonomy first');

  /** Every fabricated item with the structure it came from and whether it has a BOM. */
  const [items] = await conn.query(
    `SELECT i.id, i.name, g.name AS structure,
            (SELECT COUNT(*) FROM fab_item_bom b
              WHERE b.parent_item_id = i.id AND b.deleted_at IS NULL AND b.active = 1) AS bom
       FROM fab_item_catalog i
       JOIN fab_item_groups g ON g.id = i.group_id
      WHERE i.company_id = ? AND i.category_id = ? AND i.deleted_at IS NULL`,
    [COMPANY, cat.id]);
  const structures = [...new Set(items.map((i) => i.structure))].sort();
  console.log(`${items.length} fabricated items across ${structures.length} structures: ${structures.join(', ')}`);
  console.log(`  parts ${items.filter((i) => !Number(i.bom)).length} · assemblies ${items.filter((i) => Number(i.bom)).length}`);

  // ── the two new groups, and a subgroup per structure under each ──────────
  const groupId = new Map();
  const subgroupId = new Map();
  for (const gname of ['Parts', 'Assemblies']) {
    let [[g]] = await conn.query(
      'SELECT id FROM fab_item_groups WHERE company_id=? AND category_id=? AND name=? AND deleted_at IS NULL',
      [COMPANY, cat.id, gname]);
    if (!g && APPLY) {
      const [r] = await conn.query(
        'INSERT INTO fab_item_groups (company_id, category_id, code, name, created_at) VALUES (?,?,?,?,NOW())',
        [COMPANY, cat.id, gname.toLowerCase().slice(0, 20), gname]);
      g = { id: r.insertId };
    }
    if (!g) { console.log(`group "${gname}": would create`); continue; }
    groupId.set(gname, g.id);

    for (const s of structures) {
      let [[sg]] = await conn.query(
        'SELECT id FROM fab_item_subgroups WHERE company_id=? AND group_id=? AND name=? AND deleted_at IS NULL',
        [COMPANY, g.id, s]);
      if (!sg && APPLY) {
        const [r] = await conn.query(
          'INSERT INTO fab_item_subgroups (company_id, group_id, code, name, created_at) VALUES (?,?,?,?,NOW())',
          [COMPANY, g.id, `${short(s)}-${gname === 'Parts' ? 'P' : 'A'}`.slice(0, 20), s]);
        sg = { id: r.insertId };
      }
      if (sg) subgroupId.set(`${gname}|${s}`, sg.id);
    }
  }

  // ── re-file every item ───────────────────────────────────────────────────
  let moved = 0;
  for (const i of items) {
    const gname = Number(i.bom) > 0 ? 'Assemblies' : 'Parts';
    const gid = groupId.get(gname);
    const sid = subgroupId.get(`${gname}|${i.structure}`);
    if (!gid || !sid) continue;
    if (APPLY) {
      await conn.query('UPDATE fab_item_catalog SET group_id=?, subgroup_id=? WHERE id=? AND company_id=?',
        [gid, sid, i.id, COMPANY]);
    }
    moved++;
  }
  console.log(`items refiled: ${moved}`);

  // ── the fields that can now be narrowed properly ─────────────────────────
  for (const [gname, keys] of Object.entries(BY_GROUP)) {
    const gid = groupId.get(gname);
    if (!gid) continue;
    for (const key of keys) {
      if (APPLY) {
        await conn.query(
          `UPDATE fab_fields SET category_id=?, group_id=?, subgroup_id=NULL
            WHERE company_id=? AND field_key=? AND deleted_at IS NULL`,
          [cat.id, gid, COMPANY, key]);
      }
      console.log(`  field ${key} -> Fabricated > ${gname}`);
    }
  }

  // ── a piece no longer has a size of its own ──────────────────────────────
  const [[vals]] = await conn.query(
    `SELECT COUNT(*) n FROM fab_field_values fv JOIN fab_fields ff ON ff.id=fv.field_id
      WHERE fv.company_id=? AND ff.field_key IN ('length_mm','width_mm')
        AND fv.scope='stock_piece' AND fv.deleted_at IS NULL`, [COMPANY]);
  const [[pieces]] = await conn.query(
    'SELECT COUNT(*) n FROM fab_stock_pieces WHERE company_id=? AND deleted_at IS NULL', [COMPANY]);
  console.log(`stock-piece length/width values: ${vals.n}   stock pieces: ${pieces.n}`);
  if (APPLY) {
    await conn.query(
      `UPDATE fab_field_values fv JOIN fab_fields ff ON ff.id=fv.field_id
          SET fv.deleted_at = UTC_TIMESTAMP()
        WHERE fv.company_id=? AND ff.field_key IN ('length_mm','width_mm')
          AND fv.scope='stock_piece' AND fv.deleted_at IS NULL`, [COMPANY]);
    // order_item, not catalog_item: an order row legitimately carries a cut size
    // that differs from the plate it came off.
    await conn.query(
      `UPDATE fab_fields SET applies_at='order_item'
        WHERE company_id=? AND field_key IN ('length_mm','width_mm') AND deleted_at IS NULL`, [COMPANY]);
    await conn.query(
      'UPDATE fab_stock_pieces SET deleted_at = UTC_TIMESTAMP() WHERE company_id=? AND deleted_at IS NULL',
      [COMPANY]);
  }

  if (!APPLY) console.log('\nDRY RUN — pass --apply.');
  else { await conn.commit(); console.log('committed'); }
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally { conn.release(); await pool.end(); }
