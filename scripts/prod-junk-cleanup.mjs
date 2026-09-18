/**
 * prod-junk-cleanup.mjs — the catalog rows the 2026-09-17 audit found unused,
 * and the UAT items filed under Fabricated with no family. Agreed with the
 * product owner 2026-09-18.
 *
 *   1. Soft-delete five rows used nowhere — but only after re-checking, per row,
 *      that nothing points at it (BOM lines, order rows and lines, stock, the
 *      ledger, task inputs, machine types). A row something now points at is
 *      reported and left alone.
 *   2. File the UAT items (Fabricated, no group) under the "UAT Plate Girder"
 *      family: Assemblies if the item has BOM lines of its own, Parts if not.
 *
 * Soft deletes only; TiDB `AS OF TIMESTAMP` also covers ~10 minutes.
 *
 *   node scripts/prod-junk-cleanup.mjs --prod           # dry run
 *   node scripts/prod-junk-cleanup.mjs --prod --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.argv.includes('--prod');
const APPLY = process.argv.includes('--apply');
if (PROD) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, {
    DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
  });
}
const { pool } = await import('../db.js');

const CO = 30005;
const JUNK = [
  { name: 'Composite Girder - Shaurya', category: 'Fabricated' },
  { name: 'Composite Girdir Shaurya', category: 'Fabricated' },
  { name: 'Mark No', category: 'Fabricated' },
  { name: 'Composite Girder', category: 'Finished Goods' },
  { name: 'Special Item', category: null },
];

/** How many live things point at a catalog item. */
async function references(conn, id) {
  const checks = [
    ['BOM lines', 'SELECT COUNT(*) n FROM fab_item_bom WHERE deleted_at IS NULL AND (parent_item_id = ? OR child_item_id = ? OR pick_default_item_id = ?)', [id, id, id]],
    ['order rows', 'SELECT COUNT(*) n FROM fab_items WHERE deleted_at IS NULL AND (catalog_item_id = ? OR role_item_id = ?)', [id, id]],
    ['order lines', 'SELECT COUNT(*) n FROM fab_order_lines WHERE deleted_at IS NULL AND (catalog_item_id = ? OR template_item_id = ?)', [id, id]],
    ['stock pieces', 'SELECT COUNT(*) n FROM fab_stock_pieces WHERE deleted_at IS NULL AND catalog_item_id = ?', [id]],
    ['ledger rows', 'SELECT COUNT(*) n FROM fab_stock_ledger WHERE catalog_item_id = ?', [id]],
    ['task inputs', 'SELECT COUNT(*) n FROM fab_task_inputs WHERE deleted_at IS NULL AND ref_catalog_item_id = ?', [id]],
    ['machine types', 'SELECT COUNT(*) n FROM fab_resource_types WHERE deleted_at IS NULL AND catalog_item_id = ?', [id]],
  ];
  const found = [];
  for (const [label, sql, args] of checks) {
    const [[r]] = await conn.query(sql, args);
    if (Number(r.n) > 0) found.push(`${r.n} ${label}`);
  }
  return found;
}

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  console.log(`${PROD ? 'PROD' : 'LOCAL'} — 1. unused rows`);
  for (const j of JUNK) {
    const [rows] = await conn.query(
      `SELECT c.id, c.code FROM fab_item_catalog c
         LEFT JOIN fab_item_categories k ON k.id = c.category_id
        WHERE c.company_id = ? AND c.name = ? AND c.deleted_at IS NULL
          AND ${j.category == null ? 'c.category_id IS NULL' : 'k.name = ?'}`,
      j.category == null ? [CO, j.name] : [CO, j.name, j.category],
    );
    if (!rows.length) { console.log(`  —  "${j.name}" (${j.category ?? 'no category'}): not found`); continue; }
    for (const r of rows) {
      const refs = await references(conn, r.id);
      if (refs.length) { console.log(`  !  "${j.name}" #${r.id} ${r.code}: in use (${refs.join(', ')}) — LEFT ALONE`); continue; }
      console.log(`  ✓  "${j.name}" #${r.id} ${r.code}: nothing points at it — retire`);
      if (APPLY) await conn.query('UPDATE fab_item_catalog SET deleted_at = NOW() WHERE id = ? AND company_id = ?', [r.id, CO]);
    }
  }

  console.log('\n2. UAT items with no family');
  const [[fam]] = await conn.query(
    `SELECT g.id FROM fab_item_groups g JOIN fab_item_categories k ON k.id = g.category_id
      WHERE g.company_id = ? AND g.name = 'UAT Plate Girder' AND k.name = 'Fabricated' AND g.deleted_at IS NULL LIMIT 1`,
    [CO],
  );
  if (!fam) {
    console.log('  —  no "UAT Plate Girder" family here; nothing to file');
  } else {
    const [subs] = await conn.query(
      'SELECT id, name FROM fab_item_subgroups WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL',
      [CO, fam.id],
    );
    const subId = (n) => subs.find((s) => s.name === n)?.id ?? null;
    const [loose] = await conn.query(
      `SELECT c.id, c.name, c.code,
              (SELECT COUNT(*) FROM fab_item_bom b WHERE b.parent_item_id = c.id AND b.deleted_at IS NULL) AS line_count
         FROM fab_item_catalog c JOIN fab_item_categories k ON k.id = c.category_id
        WHERE c.company_id = ? AND k.name = 'Fabricated' AND c.group_id IS NULL
          AND c.deleted_at IS NULL AND c.name LIKE 'UAT%'`,
      [CO],
    );
    for (const it of loose) {
      const sub = Number(it.line_count) > 0 ? 'Assemblies' : 'Parts';
      console.log(`  ✓  "${it.name}" ${it.code} → UAT Plate Girder › ${sub}`);
      if (APPLY) {
        await conn.query('UPDATE fab_item_catalog SET group_id = ?, subgroup_id = ? WHERE id = ? AND company_id = ?',
          [fam.id, subId(sub), it.id, CO]);
      }
    }
    if (!loose.length) console.log('  —  none left');
  }

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
