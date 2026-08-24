/**
 * weight-nochange-test.mjs — would recomputing an order change its tonnage?
 *
 * Usage: node scripts/kepl/weight-nochange-test.mjs <companyId>
 *
 * TWO THINGS, and the second is why this exists.
 *
 * 1. `recomputeOrderWeights` now falls back to a SPEC-based density for a
 *    childless row with no material link, so a part weighs something before it
 *    has been nested. Every order that exists today was built the old way and
 *    already has links, so the fallback must not fire on them at all.
 *
 * 2. It caught a live 5× understatement waiting to be written. "Is this row a
 *    piece of raw material" was inferred as `catalog_item_id IS NOT NULL AND
 *    flow_id IS NULL`, which every TYPED assembly began satisfying on
 *    2026-08-21 — so the roll-up, which correctly skips material when summing a
 *    parent's children, stopped counting every span's four girders. KEPL
 *    computed 131.56 MT against a stored 657.86. Nothing had recomputed the
 *    order since, so the stored figure was still right and no error was ever
 *    raised; the next BOQ import would have written the wrong one in.
 *
 * READ-ONLY. The recompute runs inside a transaction that is always rolled back,
 * so this can be pointed at production without writing anything. It is the only
 * honest way to check: the function's whole job is to write, so the alternative
 * is to trust that it wrote the same numbers back.
 */

import { pool } from '../../db.js';
import { recomputeOrderWeights } from '../../apps/fab_erp/services/itemWeightService.js';
import { isMaterialLink } from '../../apps/fab_erp/services/itemMaterialService.js';

const companyId = Number(process.argv[2]);
if (!companyId) {
  console.error('Usage: node scripts/kepl/weight-nochange-test.mjs <companyId>');
  process.exit(1);
}

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};
const mt = (kg) => (kg == null ? 'null' : (Number(kg) / 1000).toFixed(2));

try {
  /**
   * FIRST, the bug this file was written to catch, checked directly.
   *
   * The old "is this a raw-material link" test was `catalog_item_id IS NOT NULL
   * AND flow_id IS NULL`, which stopped being true the day every order row was
   * given a TYPE from the item catalog: a span carries COMPOS-SPAN and no flow
   * and so began answering yes. Since the weight roll-up SKIPS material links
   * when summing a parent's children, every span silently stopped counting its
   * girders — a 5× understatement that no error would ever have reported.
   *
   * This asserts the shape rather than the arithmetic, so it still catches the
   * problem on an order whose stored figures happen to be wrong for some other
   * reason.
   */
  const [shapes] = await pool.query(
    `SELECT id, level_kind, catalog_item_id, flow_id FROM fab_items
      WHERE company_id = ? AND deleted_at IS NULL
        AND (catalog_item_id IS NOT NULL OR level_kind = 'material')`,
    [companyId],
  );
  // What the OLD test would have said, against what the row actually is.
  const oldTest = (r) => r.catalog_item_id != null && r.flow_id == null;
  const truth = (r) => r.level_kind === 'material';
  const wouldHaveDrifted = shapes.filter((r) => oldTest(r) && !truth(r) && r.level_kind != null);
  const predicateWrong = shapes.filter((r) => isMaterialLink(r) !== truth(r) && r.level_kind != null);

  console.log('material-link identification:');
  check('the predicate in use agrees with the row\'s own label, every row',
    predicateWrong.length === 0,
    predicateWrong.length
      ? `${predicateWrong.length} disagree, e.g. id ${predicateWrong[0].id} (${predicateWrong[0].level_kind})`
      : `${shapes.length} rows checked`);
  console.log(`        (the OLD inferred test would have miscounted ${wouldHaveDrifted.length}`
    + `${wouldHaveDrifted.length ? `: ${[...new Set(wouldHaveDrifted.map((r) => r.level_kind))].join(', ')}` : ''}`
    + ' — that is the bug this guards)');
  console.log('');

  const [orders] = await pool.query(
    `SELECT o.id, o.order_number AS num,
            (SELECT SUM(i.total_weight) FROM fab_items i
              WHERE i.order_id = o.id AND i.deleted_at IS NULL
                AND i.parent_item_id IS NULL) AS totalKg,
            (SELECT COUNT(*) FROM fab_items i
              WHERE i.order_id = o.id AND i.deleted_at IS NULL) AS items
       FROM fab_orders o
      WHERE o.company_id = ? AND o.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM fab_items i
                     WHERE i.order_id = o.id AND i.deleted_at IS NULL)
      ORDER BY o.id`,
    [companyId],
  );
  console.log(`${orders.length} order(s) with items\n`);

  for (const o of orders) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const after = await recomputeOrderWeights(companyId, o.id, conn);
      // The order total as the recompute would leave it, read inside the
      // uncommitted transaction.
      const [[sum]] = await conn.query(
        `SELECT SUM(total_weight) AS kg FROM fab_items
          WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL
            AND parent_item_id IS NULL`,
        [companyId, o.id],
      );
      await conn.rollback();

      const before = o.totalKg == null ? null : Number(o.totalKg);
      const now = sum?.kg == null ? null : Number(sum.kg);
      const moved = before == null || now == null
        ? before !== now
        : Math.abs(before - now) > 1; // 1 kg, well inside decimal noise
      check(`${o.num} (${o.items} rows) stays at ${mt(before)} MT`,
        !moved, moved ? `it became ${mt(now)} MT` : '');
      if (after.updated) {
        console.log(`        (${after.updated} row(s) would be rewritten — expected when`
          + ' nothing had been computed yet)');
      }
    } finally { conn.release(); }
  }
} catch (err) {
  fail++;
  console.error(`\nERROR: ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  console.log(fail ? `\n${fail} ORDER(S) MOVED\n` : '\nno order changed weight\n');
  await pool.end();
  process.exitCode = fail ? 1 : 0;
}
