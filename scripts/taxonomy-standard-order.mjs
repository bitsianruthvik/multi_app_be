/**
 * taxonomy-standard-order.mjs — category > group > subgroup, read in that order.
 *
 *   from   Fabricated > Parts            > Composite Girder
 *   to     Fabricated > Composite Girder > Parts
 *
 * WHY IT WAS BACKWARDS. A field scopes through one category id, one group id and
 * one subgroup id, so "Parts" had to be the GROUP for `num_holes` to reach all
 * sixty-one of them — as a subgroup the name repeats under five groups and a
 * field can only name one. That bought a field scoping nothing enforces: the
 * fields route returns the whole registry and exactly one screen filters it.
 *
 * So the trade was a real cost — every picker and breadcrumb reading
 * "Fabricated > Assemblies > Composite Girder" — against a benefit that is not
 * switched on. Put back the way anyone would expect to read it, and the two
 * fields that wanted Parts fall back to the category, which is what they had
 * yesterday.
 *
 *   node scripts/taxonomy-standard-order.mjs            # report
 *   node scripts/taxonomy-standard-order.mjs --apply
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

/** Fields that wanted the Parts/Assemblies split and can no longer have it. */
const FALLBACK_TO_CATEGORY = [
  'edge_length_m', 'num_holes', 'weld_length_m', 'span_ref', 'sell_rate_per_kg',
];

const short = (s) => String(s).split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 8);

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [[cat]] = await conn.query(
    "SELECT id FROM fab_item_categories WHERE company_id=? AND name='Fabricated' AND deleted_at IS NULL",
    [COMPANY]);
  if (!cat) throw new Error('category "Fabricated" not found');

  /*
   * Every fabricated item, with the two facts that decide where it goes: which
   * structure it belongs to (currently its SUBGROUP) and whether it has a BOM.
   * The split is re-derived rather than read off the old group, so a mis-filed
   * row is corrected rather than carried across.
   */
  const [items] = await conn.query(
    `SELECT i.id, i.name, sg.name AS structure,
            (SELECT COUNT(*) FROM fab_item_bom b
              WHERE b.parent_item_id = i.id AND b.deleted_at IS NULL AND b.active = 1) AS bom
       FROM fab_item_catalog i
       LEFT JOIN fab_item_subgroups sg ON sg.id = i.subgroup_id
      WHERE i.company_id = ? AND i.category_id = ? AND i.deleted_at IS NULL`,
    [COMPANY, cat.id]);
  const structures = [...new Set(items.map((i) => i.structure).filter(Boolean))].sort();
  console.log(`${items.length} items across ${structures.length} structures: ${structures.join(', ')}`);

  // ── one group per structure, one Parts/Assemblies subgroup under each ────
  const groupId = new Map();
  const subgroupId = new Map();
  for (const s of structures) {
    let [[g]] = await conn.query(
      'SELECT id FROM fab_item_groups WHERE company_id=? AND category_id=? AND name=? AND deleted_at IS NULL',
      [COMPANY, cat.id, s]);
    if (!g && APPLY) {
      const [r] = await conn.query(
        'INSERT INTO fab_item_groups (company_id, category_id, code, name, created_at) VALUES (?,?,?,?,NOW())',
        [COMPANY, cat.id, short(s).toLowerCase().slice(0, 20), s]);
      g = { id: r.insertId };
    }
    if (!g) { console.log(`group "${s}": would create`); continue; }
    groupId.set(s, g.id);

    for (const kind of ['Parts', 'Assemblies']) {
      let [[sg]] = await conn.query(
        'SELECT id FROM fab_item_subgroups WHERE company_id=? AND group_id=? AND name=? AND deleted_at IS NULL',
        [COMPANY, g.id, kind]);
      if (!sg && APPLY) {
        const [r] = await conn.query(
          'INSERT INTO fab_item_subgroups (company_id, group_id, code, name, created_at) VALUES (?,?,?,?,NOW())',
          [COMPANY, g.id, `${short(s)}-${kind === 'Parts' ? 'P' : 'A'}`.slice(0, 20), kind]);
        sg = { id: r.insertId };
      }
      if (sg) subgroupId.set(`${s}|${kind}`, sg.id);
    }
  }

  let moved = 0;
  for (const i of items) {
    if (!i.structure) continue;
    const kind = Number(i.bom) > 0 ? 'Assemblies' : 'Parts';
    const gid = groupId.get(i.structure);
    const sid = subgroupId.get(`${i.structure}|${kind}`);
    if (!gid || !sid) continue;
    if (APPLY) {
      await conn.query('UPDATE fab_item_catalog SET group_id=?, subgroup_id=? WHERE id=? AND company_id=?',
        [gid, sid, i.id, COMPANY]);
    }
    moved++;
  }
  console.log(`items refiled: ${moved}`);

  // ── the five fields lose their group and keep the category ──────────────
  if (APPLY) {
    await conn.query(
      `UPDATE fab_fields SET group_id=NULL, subgroup_id=NULL
        WHERE company_id=? AND field_key IN (?) AND deleted_at IS NULL`,
      [COMPANY, FALLBACK_TO_CATEGORY]);
  }
  console.log(`fields back to category scope: ${FALLBACK_TO_CATEGORY.join(', ')}`);

  // ── the now-empty Parts / Assemblies GROUPS go ───────────────────────────
  const [[stale]] = await conn.query(
    `SELECT COUNT(*) n FROM fab_item_groups g
      WHERE g.company_id=? AND g.category_id=? AND g.name IN ('Parts','Assemblies')
        AND g.deleted_at IS NULL`, [COMPANY, cat.id]);
  console.log(`stale Parts/Assemblies groups to retire: ${stale.n}`);
  if (APPLY && stale.n) {
    // Their subgroups go with them, or the next reader finds "Composite Girder"
    // hanging under a group nothing points at.
    await conn.query(
      `UPDATE fab_item_subgroups sg
         JOIN fab_item_groups g ON g.id = sg.group_id
          SET sg.deleted_at = UTC_TIMESTAMP()
        WHERE g.company_id=? AND g.category_id=? AND g.name IN ('Parts','Assemblies')
          AND sg.deleted_at IS NULL`, [COMPANY, cat.id]);
    await conn.query(
      `UPDATE fab_item_groups SET deleted_at = UTC_TIMESTAMP()
        WHERE company_id=? AND category_id=? AND name IN ('Parts','Assemblies') AND deleted_at IS NULL`,
      [COMPANY, cat.id]);
  }

  if (!APPLY) console.log('\nDRY RUN — pass --apply.');
  else { await conn.commit(); console.log('committed'); }
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally { conn.release(); await pool.end(); }
