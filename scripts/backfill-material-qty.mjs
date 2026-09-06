/**
 * backfill-material-qty.mjs — say on the material row how many pieces it covers.
 *
 * A material row records "this part is cut from this plate". Its `qty` was
 * always written as 1 and the piece count was read off the PART instead, which
 * worked only while a part belonged to exactly one plate.
 *
 * Now a part may be cut from several — 90 pieces from one sheet and 54 from the
 * next — so the count has to live on the row that names the plate. Rows written
 * before that change say 1 where they mean 12, and anything summing steel reads
 * them low.
 *
 * This sets each existing row to its part's quantity, which is what the old code
 * assumed and never wrote down. Only rows that still disagree are touched, so
 * running it twice changes nothing, and a genuine split (already smaller than
 * its part's qty for a good reason) is left alone by the --only-ones guard.
 *
 *   node scripts/backfill-material-qty.mjs            # report
 *   node scripts/backfill-material-qty.mjs --apply
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

/*
 * ONLY ROWS THAT STILL READ 1. A row already carrying a real count is either
 * correct or a deliberate split, and either way it is not this script's to
 * rewrite. That is what makes re-running safe.
 */
const WHERE = `
  FROM fab_items m
  JOIN fab_items p ON p.id = m.parent_item_id AND p.deleted_at IS NULL
 WHERE m.deleted_at IS NULL AND m.node_kind = 'material'
   AND COALESCE(m.qty, 1) = 1 AND COALESCE(p.qty, 1) > 1`;

const [[before]] = await pool.query(
  `SELECT COUNT(*) n, SUM(COALESCE(p.qty,1)) pieces ${WHERE}`);
console.log(`${before.n} material row(s) read 1 where their part wants more `
  + `(${Number(before.pieces)} pieces in total)`);

if (!APPLY) { console.log('\nDRY RUN — pass --apply.'); await pool.end(); process.exit(0); }

const [res] = await pool.query(
  `UPDATE fab_items m
     JOIN fab_items p ON p.id = m.parent_item_id AND p.deleted_at IS NULL
      SET m.qty = p.qty
    WHERE m.deleted_at IS NULL AND m.node_kind = 'material'
      AND COALESCE(m.qty, 1) = 1 AND COALESCE(p.qty, 1) > 1`);
console.log(`updated ${res.affectedRows} row(s)`);

const [[after]] = await pool.query(`SELECT COUNT(*) n ${WHERE}`);
console.log(`${after.n} row(s) still disagree (expected 0)`);
await pool.end();
