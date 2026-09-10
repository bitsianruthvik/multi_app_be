/**
 * retire-stale-categories.mjs — five categories that promise items they do not have.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * The catalogue offers "Composite Girder" as a category. Pick it and the screen
 * says "Catalog is empty", which reads as a broken filter — and it was reported
 * as one. The filter is fine. The category is genuinely empty.
 *
 * These five date from before the taxonomy changed. Structure types used to BE
 * categories; they are now GROUPS under `Fabricated`, which is why every
 * Composite Girder item lives at:
 *
 *     Fabricated  >  Composite Girder  >  Parts | Assemblies
 *
 * and the old top-level `Composite Girder` was left behind holding nothing. An
 * empty option that looks like a real one is worse than no option: it does not
 * fail, it just quietly shows nothing, and the reader concludes the software is
 * broken rather than that they picked the wrong door.
 *
 * ── WHAT WAS CHECKED FIRST ───────────────────────────────────────────────────
 *
 * A category is pointed at from seven places — catalog items, groups, field
 * definitions, field scope rules, fields, mark schemes and progress templates.
 * All seven were counted for these five ids and every one came back zero, so
 * this retires names and nothing else. Anything non-zero and the right answer
 * would have been to re-point it, not to delete.
 *
 *   node scripts/retire-stale-categories.mjs           # dry run
 *   node scripts/retire-stale-categories.mjs --apply
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

/** Every column in the schema that names a category. All of them are checked. */
const REFERENCES = [
  ['fab_item_catalog', 'category_id'],
  ['fab_item_groups', 'category_id'],
  ['fab_field_defs', 'category_id'],
  ['fab_item_scope_rules', 'category_id'],
  ['fab_fields', 'category_id'],
  ['fab_mark_schemes', 'item_category_id'],
  ['fab_progress_templates', 'match_item_category_id'],
];

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  /*
   * EMPTY AND CHILDLESS, not merely empty. `Finished Goods` and `Packaging` are
   * also holding no items today, but they have groups under them — they are a
   * taxonomy waiting to be used, which is a different thing from a leftover.
   */
  const [candidates] = await conn.query(
    `SELECT c.id, c.name FROM fab_item_categories c
      WHERE c.company_id = ? AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fab_item_catalog ci
                         WHERE ci.category_id = c.id AND ci.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM fab_item_groups g
                         WHERE g.category_id = c.id AND g.deleted_at IS NULL)
      ORDER BY c.name`,
    [COMPANY],
  );

  if (!candidates.length) { console.log('Nothing empty and childless. Nothing to do.'); }
  const ids = candidates.map((c) => c.id);

  console.log(`EMPTY, CHILDLESS CATEGORIES — ${candidates.length}\n`);
  let blocked = 0;
  for (const c of candidates) {
    const hits = [];
    for (const [table, col] of REFERENCES) {
      const [[r]] = await conn.query(
        `SELECT COUNT(*) n FROM ${table} WHERE ${col} = ? AND deleted_at IS NULL`, [c.id]);
      if (Number(r.n)) hits.push(`${table} ${r.n}`);
    }
    if (hits.length) { blocked += 1; console.log(`  KEEP  ${c.name} — still named by ${hits.join(', ')}`); }
    else {
      const survivor = await conn.query(
        `SELECT g.id FROM fab_item_groups g JOIN fab_item_categories cat ON cat.id = g.category_id
          WHERE g.company_id = ? AND g.deleted_at IS NULL AND g.name = ? LIMIT 1`,
        [COMPANY, c.name],
      ).then(([r]) => r[0]);
      console.log(`  DROP  ${c.name}${survivor ? '  — the name lives on as a GROUP under Fabricated' : ''}`);
    }
  }

  if (APPLY && ids.length && blocked === 0) {
    await conn.query(
      `UPDATE fab_item_categories SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)`,
      [COMPANY, ids],
    );
  }

  const [after] = await conn.query(
    `SELECT c.name,
            (SELECT COUNT(*) FROM fab_item_catalog ci
              WHERE ci.category_id = c.id AND ci.deleted_at IS NULL) AS items
       FROM fab_item_categories c
      WHERE c.company_id = ? AND c.deleted_at IS NULL ORDER BY items DESC, c.name`,
    [COMPANY],
  );
  console.log('\nCATEGORIES AFTERWARDS:\n');
  for (const r of after) console.log(`  ${String(r.name).padEnd(26)} ${r.items}`);

  if (APPLY) { await conn.commit(); console.log('\nCommitted.'); }
  else console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
