/**
 * ladder-equiv.mjs — does the batched chainsFor agree with the one-at-a-time
 * chainFor, node for node?
 *
 * The batched walk is a SECOND implementation of the ladder, and a second
 * implementation that disagrees with the first is worse than the slow one it
 * replaced: every field value in the system is resolved through it, and a
 * chain that differs by one rung silently changes which value wins.
 *
 * ALREADY LOCAL-ONLY (`../../db.js`, not `.env.tidb`) — despite living in
 * `scripts/kepl/`, this file has no TiDB-loading code anywhere in it, verified
 * by grep. `--local` is required anyway, as a deliberate safety rail matching
 * the rest of this directory rather than because this particular file needs
 * it: a script that starts safe and later gains a `.env.tidb` import (as its
 * neighbours in this folder do) should not silently start running against
 * production the day that happens.
 */
import { pool } from '../../db.js';
import { chainFor, chainsFor } from '../../apps/fab_erp/services/fieldLadder.js';

const args = process.argv.slice(2);
if (!args.includes('--local')) {
  console.error('Refusing to run without --local. See EU_BRIEF_COMMON.md: never touch .env.tidb / production from this script.');
  process.exit(1);
}
// Default to the local fixture company (6, "placebo") — company 30005 (KEPL)
// has zero rows in local sqldb, which would make this pass trivially on an
// empty target list rather than actually exercising the walk.
const companyId = Number(args.find((a) => a.startsWith('--company='))?.split('=')[1] ?? 6);

const [items] = await pool.query(
  `SELECT id FROM fab_items WHERE company_id = ? AND deleted_at IS NULL ORDER BY RAND() LIMIT 60`,
  [companyId],
);
const [pieces] = await pool.query(
  `SELECT id FROM fab_stock_pieces WHERE company_id = ? AND deleted_at IS NULL LIMIT 10`, [companyId],
);
const [cats] = await pool.query(
  `SELECT id FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL ORDER BY RAND() LIMIT 20`,
  [companyId],
);
// bom_line — EU-15 item 1: parentsOfMany's bom_line case was a broken copy of
// parentOf (undefined scopeId, returned a single object instead of
// populating `out`); this is the case that would have caught it.
const [bomLines] = await pool.query(
  `SELECT id FROM fab_item_bom WHERE company_id = ? AND deleted_at IS NULL ORDER BY RAND() LIMIT 20`,
  [companyId],
);

const targets = [
  ...items.map((r) => ({ scope: 'order_item', scopeId: r.id })),
  ...pieces.map((r) => ({ scope: 'stock_piece', scopeId: r.id })),
  ...cats.map((r) => ({ scope: 'catalog_item', scopeId: r.id })),
  ...bomLines.map((r) => ({ scope: 'bom_line', scopeId: r.id })),
];

const t0 = Date.now();
const batched = await chainsFor(companyId, targets);
const tBatched = Date.now() - t0;

const t1 = Date.now();
let mismatches = 0;
for (const t of targets) {
  const one = await chainFor(companyId, t.scope, t.scopeId);
  const many = batched.get(`${t.scope}:${t.scopeId}`) ?? [];
  const a = one.map((n) => `${n.scope}:${n.scopeId}`).join(' > ');
  const b = many.map((n) => `${n.scope}:${n.scopeId}`).join(' > ');
  if (a !== b) {
    mismatches++;
    if (mismatches <= 5) console.log(`MISMATCH ${t.scope}:${t.scopeId}\n  one-at-a-time: ${a}\n  batched      : ${b}`);
  }
}
const tSingle = Date.now() - t1;

console.log(`\n${targets.length} targets`);
console.log(`batched        ${tBatched} ms`);
console.log(`one-at-a-time  ${tSingle} ms  (${(tSingle / tBatched).toFixed(0)}x slower)`);
console.log(mismatches ? `\n${mismatches} MISMATCHES` : '\nIDENTICAL — every chain matches, rung for rung.');
await pool.end();
