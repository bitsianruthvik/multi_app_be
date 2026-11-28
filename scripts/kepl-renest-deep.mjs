/**
 * kepl-renest-deep.mjs — nest the order again, deep, and accept the plan.
 *
 * The blanks moved twice since the last plan was accepted: stiffeners came out
 * of the recipe and their counts changed per girder, and the holed intermediate
 * stiffener went back to 178 wide, which is a rectangle the order never had.
 *
 * Deep is 2,000 restarts of the packer, seeded off the order id, so the same
 * order nests the same way twice. It takes about five minutes.
 *
 *   node scripts/kepl-renest-deep.mjs           # nest, show the plan, write nothing
 *   node scripts/kepl-renest-deep.mjs --accept
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { useProdDb } from './lib/prodDb.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
await useProdDb();
const { pool } = await import('../db.js');
const { blankPlan } = await import('../apps/fab_erp/services/blankPlanService.js');
const { acceptNestingPlan } = await import('../apps/fab_erp/services/blankService.js');

const ACCEPT = process.argv.includes('--accept');
const C = 30005;
const ORDER = 1410063;

const started = Date.now();
const plan = await blankPlan(C, ORDER, { effort: 'deep', repack: true });
console.log(`nested in ${Math.round((Date.now() - started) / 1000)}s · ${plan.provenance ?? ''}`);
console.log(`blanks ${plan.summary.blanks} · sheets ${plan.summary.plates} · steel ${(plan.summary.boughtKg / 1000).toFixed(1)} t · yield ${(plan.summary.yield * 100).toFixed(1)}%`);
const short = plan.blanks.filter((b) => b.short > 0);
if (short.length) console.log(`NOT FULLY PLACED: ${short.map((b) => `${b.thickness}×${b.width}×${b.length} short ${b.short}`).join(', ')}`);
console.log('\nblanks:');
for (const b of plan.blanks) {
  console.log(`  ${String(b.qty).padStart(5)} × ${b.thickness}×${b.width}×${b.length}  from ${b.plateSizes[0] ?? '—'}  ${b.plateCount} sheet(s)`);
}

if (!ACCEPT) {
  console.log('\nNot accepted. Re-run with --accept.');
  await pool.end();
  process.exit(0);
}

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const res = await acceptNestingPlan(C, ORDER, {
    nests: plan.nests,
    // Every blank cut by the cutting default.
    flows: {},
    provenance: plan.provenance ?? undefined,
  }, conn);
  await conn.commit();
  console.log(`\nACCEPTED: ${res.blanks} blanks across ${res.sheets} sheets on ${res.cuttingOrderNumber}; ${res.partsRepointed} part rows now come off a blank.`);
} catch (e) {
  await conn.rollback();
  throw e;
} finally {
  conn.release();
  await pool.end();
}
