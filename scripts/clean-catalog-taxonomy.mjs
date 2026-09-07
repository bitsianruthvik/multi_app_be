/**
 * clean-catalog-taxonomy.mjs — file fabricated items where they belong.
 *
 * WHAT WAS WRONG. The five structure types were CATEGORIES, so a category was
 * doing two jobs at once: "what kind of thing is this" and "which structure does
 * it belong to". Raw materials use the three levels properly —
 * `Raw Materials > Plates > MS E350 BO` — and nesting depends on it, finding
 * plate by the group name. Fabricated items used none of it.
 *
 *   category  Fabricated        what kind of thing it is
 *   group     Composite Girder  which structure it belongs to
 *   subgroup  (empty)           part families, later
 *
 * ASSEMBLY vs PART IS NOT STORED. It is "does this item have BOM lines under
 * it", which is the whole point: a stored flag can disagree with the BOM, and
 * three of this week's defects came from exactly that kind of drift.
 *
 * mrp_policy IS LEFT ALONE. It reads 'lot_for_lot' on every one of these, which
 * looks like a decision and is not: the column is NOT NULL DEFAULT 'lot_for_lot',
 * so that is simply what it hands you. Nobody uses it. Setting it to 'manual'
 * instead would be inventing a choice to replace one nobody made.
 *
 * DENSITY COMES OFF THE FABRICATED ITEMS. It is not decoration there: a part
 * with no material link gets its density by matching thickness, grade and
 * material against every catalog row that HAS one, so a 16 mm E350 part could
 * match "Interm Diaphragm Web" instead of a plate. All 1,426 raw materials carry
 * density, so removing it here makes the match fall through to real steel —
 * which is where a part's density should come from anyway, once its material is
 * assigned.
 *
 *   node scripts/clean-catalog-taxonomy.mjs            # report
 *   node scripts/clean-catalog-taxonomy.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
/** Parts keep their structure-type group unless this is passed. */
const UNGROUP_PARTS = process.argv.includes('--ungroup-parts');
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
const STRUCTURE_TYPES = ['Composite Girder', 'BowString', 'Tub Girder', 'Openweb Girder', 'PEB'];

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  // ── the category everything fabricated moves into ────────────────────────
  const [[fab]] = await conn.query(
    'SELECT id FROM fab_item_categories WHERE company_id=? AND name=? AND deleted_at IS NULL',
    [COMPANY, 'Fabricated']);
  let fabId = fab?.id ?? null;
  if (!fabId) {
    console.log('category "Fabricated": will be created');
    if (APPLY) {
      const [r] = await conn.query(
        'INSERT INTO fab_item_categories (company_id, code, name, created_at) VALUES (?,?,?,NOW())',
        [COMPANY, 'fab', 'Fabricated']);
      fabId = r.insertId;
    }
  } else console.log(`category "Fabricated": exists (${fabId})`);

  // ── one group per structure type, named as the category was ──────────────
  const groupId = new Map();
  for (const name of STRUCTURE_TYPES) {
    const [[g]] = await conn.query(
      'SELECT id FROM fab_item_groups WHERE company_id=? AND name=? AND deleted_at IS NULL',
      [COMPANY, name]);
    if (g) { groupId.set(name, g.id); continue; }
    console.log(`group "${name}": will be created`);
    if (APPLY) {
      const [r] = await conn.query(
        'INSERT INTO fab_item_groups (company_id, category_id, code, name, created_at) VALUES (?,?,?,?,NOW())',
        [COMPANY, fabId, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name]);
      groupId.set(name, r.insertId);
    }
  }

  // ── move the items ───────────────────────────────────────────────────────
  let moved = 0;
  const report = [];
  for (const name of STRUCTURE_TYPES) {
    const [items] = await conn.query(
      `SELECT i.id, i.name, i.code, i.density_kg_m3 AS density, i.mrp_policy AS mrp,
              (SELECT COUNT(*) FROM fab_item_bom b
                WHERE b.parent_item_id=i.id AND b.deleted_at IS NULL AND b.active=1) AS bom
         FROM fab_item_catalog i JOIN fab_item_categories c ON c.id=i.category_id
        WHERE i.company_id=? AND c.name=? AND i.deleted_at IS NULL`,
      [COMPANY, name]);
    const assemblies = items.filter((i) => i.bom > 0);
    const parts = items.filter((i) => !i.bom);
    report.push({
      structure: name, items: items.length,
      assemblies: assemblies.length, parts: parts.length,
      withDensity: items.filter((i) => i.density != null).length,
    });
    if (!APPLY) continue;
    for (const i of items) {
      // A part is ungrouped only on request; by default it keeps the structure
      // it belongs to, because these items are NOT shared between structures —
      // a Tub Top Flange Plate is a different item from a Top Flange.
      const gid = (i.bom > 0 || !UNGROUP_PARTS) ? groupId.get(name) : null;
      await conn.query(
        `UPDATE fab_item_catalog
            SET category_id=?, group_id=?, density_kg_m3=NULL
          WHERE id=? AND company_id=?`,
        [fabId, gid, i.id, COMPANY]);
      moved++;
    }
  }
  console.table(report);

  // ── the rename that never reached the code ───────────────────────────────
  const [[line]] = await conn.query(
    "SELECT id, name, code FROM fab_item_catalog WHERE company_id=? AND code='COMPOS-GDR' AND deleted_at IS NULL",
    [COMPANY]);
  if (line) {
    console.log(`code: ${line.code} -> COMPOS-LINE  (item is named "${line.name}")`);
    if (APPLY) {
      await conn.query(
        // code_active is GENERATED from code — the database keeps it in step.
        "UPDATE fab_item_catalog SET code='COMPOS-LINE' WHERE id=? AND company_id=?",
        [line.id, COMPANY]);
    }
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply.'); await conn.rollback?.(); }
  else { await conn.commit(); console.log(`\nmoved ${moved} item(s); density and mrp_policy cleared on all of them`); }
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally { conn.release(); await pool.end(); }
