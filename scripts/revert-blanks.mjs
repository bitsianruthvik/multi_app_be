/**
 * revert-blanks.mjs — undo the first attempt at slice 0.
 *
 * WHAT WAS WRONG WITH IT. Blanks were filed as `Fabricated > Blanks > MS E350 BO`,
 * a shared namespace, as though a 12 x 170 x 2995 rectangle were a reusable type.
 * It is not. That span has 25 distinct shapes and only 6 distinct thicknesses:
 * the thickness and grade recur across jobs, the rectangle comes off one drawing
 * and dies with the order. Filed that way the catalog gains ~25 permanently dead
 * items per order and every picker in the app fills with them.
 *
 * Blanks are being refiled as `Raw Materials > Blanks > <order number>`, which
 * scopes them to the job that needs them and inherits the hiding that already
 * works — every picker excludes Raw Materials today.
 *
 * SOFT DELETE ONLY. `code_active` and `name_active` are generated from
 * `deleted_at`, so soft-deleting frees the name and code for reuse while the
 * history keeps pointing at something real.
 *
 *   node scripts/revert-blanks.mjs           # dry run
 *   node scripts/revert-blanks.mjs --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const APPLY = process.argv.includes('--apply');
const COMPANY = 30005;
const say = (s = '') => console.log(s);

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [[grp]] = await conn.query(
    `SELECT g.id, g.name FROM fab_item_groups g
       JOIN fab_item_categories k ON k.id = g.category_id
      WHERE g.company_id = ? AND k.name = 'Fabricated' AND g.name = 'Blanks'
        AND g.deleted_at IS NULL`,
    [COMPANY],
  );
  if (!grp) { say('No "Fabricated > Blanks" group — nothing to revert.'); }
  else {
    const [items] = await conn.query(
      `SELECT id, code, name FROM fab_item_catalog
        WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL`,
      [COMPANY, grp.id],
    );
    const ids = items.map((i) => i.id);

    const [[stamped]] = await conn.query(
      ids.length
        ? `SELECT COUNT(*) AS n FROM fab_items WHERE company_id = ? AND blank_catalog_item_id IN (?)`
        : `SELECT 0 AS n FROM DUAL`,
      ids.length ? [COMPANY, ids] : [],
    );

    say(`Fabricated > Blanks  (group ${grp.id})`);
    say(`  ${items.length} catalog item(s)`);
    say(`  ${stamped.n} part row(s) stamped with one of them`);
    say();

    if (APPLY) {
      if (ids.length) {
        await conn.query(
          `UPDATE fab_items SET blank_catalog_item_id = NULL
            WHERE company_id = ? AND blank_catalog_item_id IN (?)`,
          [COMPANY, ids],
        );
        await conn.query(
          `UPDATE fab_field_values SET deleted_at = NOW()
            WHERE company_id = ? AND scope = 'catalog_item' AND scope_id IN (?)
              AND deleted_at IS NULL`,
          [COMPANY, ids],
        );
        await conn.query(
          `UPDATE fab_item_catalog SET deleted_at = NOW()
            WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
          [COMPANY, ids],
        );
      }
      await conn.query(
        `UPDATE fab_item_subgroups SET deleted_at = NOW()
          WHERE company_id = ? AND group_id = ? AND deleted_at IS NULL`,
        [COMPANY, grp.id],
      );
      await conn.query(
        `UPDATE fab_item_groups SET deleted_at = NOW() WHERE company_id = ? AND id = ?`,
        [COMPANY, grp.id],
      );
      say(`Soft-deleted ${items.length} item(s), their field values, the subgroup(s) and the group.`);
      say(`Cleared ${stamped.n} stamp(s).`);
    } else {
      say(`would clear ${stamped.n} stamp(s), soft-delete ${items.length} item(s) + field values,`);
      say('would soft-delete the subgroup(s) and the group');
    }
  }

  if (APPLY) { await conn.commit(); say('\nCommitted.'); }
  else say('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
