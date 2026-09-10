/**
 * bom-no-defaults.mjs — take the guesses out of the recipe.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Five lines on the composite girder Span carried a `default_qty` — 6 lines,
 * 5 segments each, 16 splices, 45 intermediate diaphragms, 6 end diaphragms.
 * They were typed when the BOM was authored and they are true of exactly one
 * bridge: the one somebody had in front of them that day.
 *
 * They were harmless while a wizard stopped and asked. It does not any more, so
 * the default is simply taken — and a number that is silently right for the last
 * bridge and silently wrong for this one is worse than no number, because
 * nothing on the screen says it was assumed.
 *
 * ── THE STUDS ────────────────────────────────────────────────────────────────
 *
 * `Shear Stud 25 dia x 175` was FIXED at 7,212 — the same list as "a Segment has
 * one web plate". Studs are welded along the top flange for composite action, so
 * the count follows the span's length; fixed, it cannot. Every bridge built from
 * this recipe would have claimed 7,212, and it is the largest quantity in the
 * structure by a factor of 160.
 *
 * It becomes a parameter like the others, with no default either.
 *
 * ── WHAT A BLANK NOW DOES ────────────────────────────────────────────────────
 *
 * `draftTree` returns null rather than 0, and both writers REFUSE it. The old
 * code turned 0 into 1 — so stripping the defaults without that change would
 * have quietly built one splice instead of sixteen, and 1 reads as a decision
 * in a way a blank never does.
 *
 *   node scripts/bom-no-defaults.mjs           # dry run
 *   node scripts/bom-no-defaults.mjs --apply
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

/** Fixed lines that describe something variable, and the name to give them. */
const TO_PARAMETERISE = [
  { child: 'Shear Stud 25 dia x 175 (headed)', param: 'shearStuds' },
];

const conn = await pool.getConnection();
try {
  if (APPLY) await conn.beginTransaction();

  // ── 1. defaults come off every parameterised line ─────────────────────────
  const [withDefaults] = await conn.query(
    `SELECT b.id, p.name AS parent, ch.name AS child, b.qty_param AS param, b.default_qty AS def
       FROM fab_item_bom b
       JOIN fab_item_catalog p  ON p.id = b.parent_item_id
       JOIN fab_item_catalog ch ON ch.id = b.child_item_id
      WHERE b.company_id = ? AND b.deleted_at IS NULL
        AND b.qty_param IS NOT NULL AND b.default_qty IS NOT NULL`,
    [COMPANY],
  );
  console.log(`DEFAULTS TO REMOVE — ${withDefaults.length}\n`);
  for (const r of withDefaults) {
    console.log(`  ${r.parent} > ${String(r.child).padEnd(34)} ${r.param} = ${Number(r.def)}  ->  (asked, not assumed)`);
  }
  if (APPLY && withDefaults.length) {
    await conn.query(
      `UPDATE fab_item_bom SET default_qty = NULL
        WHERE company_id = ? AND id IN (?)`,
      [COMPANY, withDefaults.map((r) => r.id)],
    );
  }

  // ── 2. the studs stop being a fixed fact ──────────────────────────────────
  console.log('\nFIXED LINES THAT SHOULD BE PARAMETERS\n');
  for (const t of TO_PARAMETERISE) {
    const [rows] = await conn.query(
      `SELECT b.id, p.name AS parent, b.qty_num AS fixedQty
         FROM fab_item_bom b
         JOIN fab_item_catalog p  ON p.id = b.parent_item_id
         JOIN fab_item_catalog ch ON ch.id = b.child_item_id
        WHERE b.company_id = ? AND b.deleted_at IS NULL
          AND ch.name = ? AND b.qty_num IS NOT NULL`,
      [COMPANY, t.child],
    );
    if (!rows.length) { console.log(`  ${t.child}: already a parameter, or not in any BOM`); continue; }
    for (const r of rows) {
      console.log(`  ${r.parent} > ${String(t.child).padEnd(34)} fixed ${Number(r.fixedQty)}  ->  ${t.param} (asked)`);
      if (APPLY) {
        /*
         * qty_num AND qty_param cannot both be set — `setBomLine` refuses it,
         * because two answers to "how many" is worse than none. Clearing the
         * number is part of the same write.
         */
        await conn.query(
          `UPDATE fab_item_bom SET qty_num = NULL, qty_param = ?, default_qty = NULL
            WHERE company_id = ? AND id = ?`,
          [t.param, COMPANY, r.id],
        );
      }
    }
  }

  // ── what the Span will look like afterwards ───────────────────────────────
  const [after] = await conn.query(
    `SELECT ch.name AS child, b.qty_num AS fixedQty, b.qty_param AS param, b.default_qty AS def
       FROM fab_item_bom b
       JOIN fab_item_catalog p  ON p.id = b.parent_item_id
       JOIN fab_item_catalog ch ON ch.id = b.child_item_id
      WHERE b.company_id = ? AND b.deleted_at IS NULL AND p.name = 'Span'
      ORDER BY b.sort_order`,
    [COMPANY],
  );
  console.log('\nTHE SPAN, AFTER:\n');
  for (const r of after) {
    console.log(`  ${String(r.child).padEnd(34)} ${r.fixedQty != null
      ? `fixed ${Number(r.fixedQty)}`
      : `${r.param} = ${r.def == null ? '(asked)' : Number(r.def)}`}`);
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
