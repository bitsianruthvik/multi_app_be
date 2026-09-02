/**
 * kepl-derived-fields.mjs — the formula inputs that follow from the geometry.
 *
 * Each flow's operations compute their durations from named fields. Three of
 * them are just arithmetic on the length, width and thickness the BOQ gave:
 *
 *   edge_length_m     the cut perimeter, 2(L+W) — what a cutting rate multiplies
 *   surface_area_m2   both faces plus the edge band — what blasting and painting
 *                     rates multiply
 *   unit_weight_kg    volume x density, which itemWeightService has already
 *                     worked out and stored on the row
 *
 * TWO ARE NOT DERIVABLE AND ARE DELIBERATELY LEFT EMPTY:
 *
 *   num_holes         the BOQ names a part "…Hole" but never says how many
 *   weld_length_m     nowhere on the sheet
 *
 * Both come off the fabrication drawings. Filling them with a plausible-looking
 * number would put invented durations on the shop floor and into the schedule,
 * which is worse than an obviously missing value — the stage stays amber and
 * says what it wants.
 *
 *   node scripts/kepl-derived-fields.mjs           # report
 *   node scripts/kepl-derived-fields.mjs --apply
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
const { setFields } = await import('../apps/fab_erp/services/fieldService.js');

const COMPANY = 30005;
const [[order]] = await pool.query(
  `SELECT id, order_number FROM fab_orders WHERE company_id=? AND deleted_at IS NULL
     AND order_type='sales' ORDER BY id DESC LIMIT 1`, [COMPANY]);

/** Every made leaf, with the geometry already on it. */
const [rows] = await pool.query(
  `SELECT id, code, name, length, width, height,
          COALESCE(unit_weight, computed_unit_weight) AS unitWeight
     FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL
      AND node_kind='structure' AND is_leaf=1
      AND COALESCE(procurement_type,'make')='make'`, [COMPANY, order.id]);

console.log(`${order.order_number}: ${rows.length} made leaves`);
const noGeom = rows.filter((r) => !(r.length > 0 && r.width > 0));
console.log(`  without length/width: ${noGeom.length}`);

let n = 0; const rejects = new Set();
for (const r of rows) {
  const L = Number(r.length); const W = Number(r.width);
  if (!(L > 0 && W > 0)) continue;
  const t = Number(r.height) || 0;

  const vals = {
    // Perimeter of the cut, in metres.
    edge_length_m: Number((2 * (L + W) / 1000).toFixed(3)),
    // Both faces plus the edge band — what gets blasted and painted.
    surface_area_m2: Number(((2 * L * W + 2 * t * (L + W)) / 1e6).toFixed(4)),
  };
  if (r.unitWeight != null) vals.unit_weight_kg = Number(Number(r.unitWeight).toFixed(3));

  if (!APPLY) { n += 1; continue; }
  const { rejected } = await setFields(COMPANY, 'order_item', r.id, vals);
  for (const rej of rejected) rejects.add(`${rej.fieldKey}: ${rej.why}`);
  if ((++n % 200) === 0) console.log(`    ${n}/${rows.length}`);
}

console.log(`${APPLY ? 'wrote' : 'would write'} edge_length_m + surface_area_m2 (+ unit_weight_kg) to ${n} parts`);
if (rejects.size) { console.log('rejected:'); for (const x of rejects) console.log('  ', x); }
console.log('\nNOT set, and not derivable from this BOQ:');
console.log('  num_holes      — the sheet names a part "…Hole" but never counts them');
console.log('  weld_length_m  — nowhere on the sheet');
console.log('  Both come off the fabrication drawings.');
await pool.end();
