/**
 * cut-plates-migrate.mjs — move existing blanks to Cut Plates and recode them.
 *
 * Since 2026-09-18 a cut plate (a "blank", material_form = 'blank') is filed
 * `Cut Plates › <order number>` and coded CP-…, where it used to be
 * `Raw Materials › Blanks › <order number>` and BLK-…. New nesting already
 * writes the new shape, and `blankService.materialiseBlanks` finds an old one by
 * its BLK- code and moves it on the next re-nest — this moves every one now, so
 * the catalog reads one way.
 *
 * Safe to re-run: an item already under Cut Plates with a CP- code is skipped.
 * Only the category, group, sub-group and code change. Order rows, stock pieces,
 * task inputs and nest issues all point at the catalog ID, which is unchanged.
 * The emptied `Raw Materials › Blanks › <order>` sub-groups are retired.
 *
 *   node scripts/cut-plates-migrate.mjs                 # local, dry run
 *   node scripts/cut-plates-migrate.mjs --apply         # local
 *   node scripts/cut-plates-migrate.mjs --prod          # TiDB, dry run
 *   node scripts/cut-plates-migrate.mjs --prod --apply
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
const { ensureCutPlateGroup } = await import('../apps/fab_erp/services/blankService.js');

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  // Every live cut plate, with the order it was cut for — read off its old
  // sub-group (the order number) or, if already moved, its group.
  const [items] = await conn.query(
    `SELECT c.id, c.company_id AS companyId, c.code,
            k.name AS category, g.name AS grp, sg.name AS sub, sg.id AS subId
       FROM fab_item_catalog c
       LEFT JOIN fab_item_categories k ON k.id = c.category_id
       LEFT JOIN fab_item_groups g ON g.id = c.group_id
       LEFT JOIN fab_item_subgroups sg ON sg.id = c.subgroup_id
      WHERE c.material_form = 'blank' AND c.deleted_at IS NULL
      ORDER BY c.company_id, c.id`,
  );

  let moved = 0, recoded = 0, skipped = 0, conflicts = 0;
  const oldSubs = new Set();
  const perOrder = new Map();
  for (const it of items) {
    const already = it.category === 'Cut Plates' && !String(it.code).startsWith('BLK-');
    if (already) { skipped += 1; continue; }
    const orderNumber = it.category === 'Cut Plates' ? it.grp : (it.sub ?? it.grp);
    if (!orderNumber) { console.log(`  ?  #${it.id} ${it.code}: no order to file it under — left alone`); skipped += 1; continue; }

    const newCode = String(it.code).replace(/^BLK-/, 'CP-');
    if (newCode !== it.code) {
      const [[clash]] = await conn.query(
        'SELECT id FROM fab_item_catalog WHERE company_id = ? AND code = ? AND id <> ? AND deleted_at IS NULL',
        [it.companyId, newCode, it.id],
      );
      if (clash) { console.log(`  !  #${it.id} ${it.code}: ${newCode} already taken by #${clash.id} — left alone`); conflicts += 1; continue; }
    }

    perOrder.set(`${it.companyId} ${orderNumber}`, (perOrder.get(`${it.companyId} ${orderNumber}`) ?? 0) + 1);
    if (it.subId) oldSubs.add(Number(it.subId));
    if (APPLY) {
      const place = await ensureCutPlateGroup(conn, it.companyId, orderNumber);
      await conn.query(
        `UPDATE fab_item_catalog
            SET category_id = ?, group_id = ?, subgroup_id = NULL, code = ?, is_cataloged = 0
          WHERE id = ?`,
        [place.categoryId, place.groupId, newCode, it.id],
      );
    }
    moved += 1;
    if (newCode !== it.code) recoded += 1;
  }

  // The emptied Blanks sub-groups.
  let retired = 0;
  if (APPLY && oldSubs.size) {
    const [r] = await conn.query(
      `UPDATE fab_item_subgroups s SET s.deleted_at = NOW()
        WHERE s.id IN (?) AND s.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM fab_item_catalog c WHERE c.subgroup_id = s.id AND c.deleted_at IS NULL)`,
      [[...oldSubs]],
    );
    retired = r.affectedRows;
  }

  console.log(`${PROD ? 'PROD' : 'LOCAL'} — ${items.length} live cut plate(s)`);
  for (const [k, n] of perOrder) console.log(`  ${k}: ${n} → Cut Plates`);
  console.log(`\nMoved ${moved} (${recoded} recoded BLK- → CP-), ${skipped} already done, ${conflicts} code clashes, ${APPLY ? retired : oldSubs.size} old sub-group(s) ${APPLY ? 'retired' : 'to retire'}`);

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
