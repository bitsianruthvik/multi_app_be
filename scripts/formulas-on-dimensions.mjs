/**
 * formulas-on-dimensions.mjs — take the arithmetic out of the Parameters step.
 *
 * `edge_length_m` was a field somebody typed. It is the perimeter of a rectangle
 * whose sides they typed on the same screen, and checked against 1,062 real
 * parts from the KEPL BOQ it agreed with `2 * (L + W) / 1000` on every single
 * row. Two numbers for one fact is two chances to disagree, with nothing to say
 * which is right.
 *
 * So the two formulas that read it now compute it, and the field stops being
 * asked for. It is NOT deleted: 2,147 values exist on retired orders and
 * deleting the definition would orphan them. With no formula requiring it, it
 * simply stops appearing as a column.
 *
 * WHY THIS ONE AND NOT WEIGHT OR AREA. Those two are rolled up by assemblies —
 * `inputs.sum(unit_weight_kg)` — and the engine's aggregate takes a FIELD NAME,
 * not an expression, so there has to be a stored value to sum. They are
 * computed by fieldDeriveService instead and kept off the screen. Edge length is
 * summed by nothing, so it can go entirely.
 *
 * THE GUARD IS `item.length_mm > 0`, not `item.width_mm`. Either would do for a
 * part; what matters is that an ASSEMBLY has neither, so it falls to the
 * operation's own default exactly as it did before.
 *
 *   node scripts/formulas-on-dimensions.mjs           # dry run
 *   node scripts/formulas-on-dimensions.mjs --apply
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

/** The perimeter, in metres, of the rectangle the row already states. */
const PERIMETER = '2 * (item.length_mm + item.width_mm) / 1000';

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  const [ops] = await conn.query(
    `SELECT id, name, time_formula AS formula FROM fab_operations
      WHERE company_id = ? AND deleted_at IS NULL AND time_formula LIKE '%edge_length_m%'`,
    [COMPANY],
  );

  if (!ops.length) { console.log('No operation reads item.edge_length_m — nothing to do.'); }

  let changed = 0;
  for (const op of ops) {
    /*
     * Rewritten by substitution rather than by hand-writing each new formula:
     * the guard, the divisor and the thickness factor around it are somebody's
     * tuning, and retyping them is how a script quietly changes a number it was
     * never asked to touch.
     */
    const next = op.formula
      .split('item.edge_length_m > 0').join('item.length_mm > 0')
      .split('item.edge_length_m').join(`(${PERIMETER})`);

    if (next === op.formula) continue;
    changed += 1;
    console.log(`\n${op.name}`);
    console.log(`  was: ${op.formula}`);
    console.log(`  now: ${next}`);
    if (APPLY) {
      await conn.query(
        'UPDATE fab_operations SET time_formula = ? WHERE id = ? AND company_id = ?',
        [next, op.id, COMPANY],
      );
    }
  }

  console.log(`\n${changed} operation(s) ${APPLY ? 'updated' : 'would be updated'}.`);
  if (APPLY) { await conn.commit(); console.log('Committed.'); }
  else console.log('DRY RUN — nothing was written. Re-run with --apply.');
} catch (err) {
  if (APPLY) await conn.rollback();
  throw err;
} finally {
  conn.release();
  await pool.end();
}
