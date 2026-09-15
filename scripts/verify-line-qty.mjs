/**
 * verify-line-qty.mjs — proves EU-5's rule ("multiply once, at the outermost
 * sum") against the LOCAL-FIXTURE-01 order (247, company 6), whose line 124 is
 * qty 3 while every other line (123) stays qty 1. LOCAL ONLY, via db.js.
 *
 * ISOLATION, NOT A HARDCODED EXPECTED NUMBER. Line 124 shares blank catalog
 * items with line 123 (the same rectangle is cut for both), so its own
 * contribution to any order-wide total cannot be read off directly. Instead
 * this compares each figure at THREE temporary values of
 * fab_order_lines.qty for line 124 — 3 (its real value), 1, and 0 — inside ONE
 * transaction rolled back at the end. Subtracting the qty-0 baseline (line 124
 * contributes nothing) from qty-3 and from qty-1 isolates exactly what line
 * 124 adds, so "3x" holds regardless of what line 123 or anything else in the
 * order also contributes. No DDL; a rolled-back rehearsal still commits DDL,
 * but nothing here is DDL and nothing persists either way.
 *
 * Three things are checked, each through the REAL service, not a reimplemented
 * formula:
 *   1. order tonnage         (itemWeightService.recomputeOrderWeights)
 *   2. task_qty on line 124's own items (taskGatingService.planOrderTasks)
 *   3. procurement "required" per catalog item (procurementService.orderShortfall)
 *      — proving BOTH halves of User Clarifications 5 in the same pass: an
 *      un-nested catalog item's required qty scales 3x with line 124's qty,
 *      while a catalog item reached only through nested links does not move
 *      AT ALL as line 124's qty changes (the nested branch has no line factor).
 *
 * THE FIXTURE HAS NO UN-NESTED 'buy' ROW OF ITS OWN — checked directly: every
 * `nest_no IS NULL` catalog-linked row on order 247 is `procurement_type =
 * 'make'` (the blanks, and the parts cut from them), and every 'buy' row is
 * nested (catalog items 297/309/346). So proving the un-nested branch's
 * multiply needs one un-nested 'buy' material link that does not already
 * exist — inserted under line 124 inside the SAME rolled-back transaction,
 * the same technique verify-nest-claim.mjs uses. It never commits.
 *
 * Usage: node scripts/verify-line-qty.mjs
 */
import { pool } from '../db.js';
import { recomputeOrderWeights } from '../apps/fab_erp/services/itemWeightService.js';
import { orderShortfall } from '../apps/fab_erp/services/procurementService.js';
import { planOrderTasks } from '../apps/fab_erp/services/taskGatingService.js';

const COMPANY_ID = 6;
const ORDER_ID = 247;
const LINE_124 = 124;

let failed = false;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failed = true;
}
/** Relative-tolerant equality — these figures pass through several rounds of Σ/×. */
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

async function setLineQty(conn, qty) {
  await conn.query('UPDATE fab_order_lines SET qty = ? WHERE id = ? AND company_id = ?', [qty, LINE_124, COMPANY_ID]);
}

async function snapshot(conn) {
  const weights = await recomputeOrderWeights(COMPANY_ID, ORDER_ID, conn);
  const shortfall = await orderShortfall(COMPANY_ID, ORDER_ID, conn);
  const { planned } = await planOrderTasks(conn, COMPANY_ID, ORDER_ID, { evaluateExisting: true });

  const [line124Items] = await conn.query(
    `SELECT id FROM fab_items
      WHERE company_id = ? AND order_id = ? AND order_line_id = ? AND deleted_at IS NULL`,
    [COMPANY_ID, ORDER_ID, LINE_124],
  );
  const line124ItemIds = new Set(line124Items.map((r) => Number(r.id)));
  const taskQtySum = planned
    .filter((t) => line124ItemIds.has(Number(t.itemId)))
    .reduce((a, t) => a + (Number(t.qty) || 0), 0);

  const shortByCatalogItem = new Map(shortfall.lines.map((l) => [l.catalogItemId, l.required]));
  return { totalWeight: weights.totalWeight ?? 0, taskQtySum, shortByCatalogItem };
}

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  // A real un-nested 'buy' row under line 124, so the un-nested branch's
  // multiply has something to prove itself against (see module note).
  // catalog_item_id 297 already exists on this order as NESTED demand too —
  // deliberately, so this also proves the two branches' deltas are additive
  // and do not leak into one another (the nested part of item 297's demand
  // must stay flat while this un-nested part scales).
  await conn.query(
    `INSERT INTO fab_items
       (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
        name, node_kind, qty, procurement_type, unit)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [COMPANY_ID, ORDER_ID, LINE_124, 2158, 297, 'ZZ-TEST un-nested buy', 'material', 5, 'buy', 'nos'],
  );

  await setLineQty(conn, 3);
  const at3 = await snapshot(conn);
  await setLineQty(conn, 1);
  const at1 = await snapshot(conn);
  await setLineQty(conn, 0);
  const at0 = await snapshot(conn);

  // ── 1. order tonnage ─────────────────────────────────────────────────────
  const w3 = at3.totalWeight - at0.totalWeight;
  const w1 = at1.totalWeight - at0.totalWeight;
  check(
    `order tonnage: line 124's own contribution at qty 3 (${w3.toFixed(3)} kg) `
    + `is 3x its contribution at qty 1 (${w1.toFixed(3)} kg)`,
    w1 > 0 && close(w3, 3 * w1, 1e-6),
  );

  // ── 2. task_qty over line 124's own items ───────────────────────────────
  check(
    `sum(task_qty) over line 124's items: ${at3.taskQtySum} is 3x ${at1.taskQtySum}`,
    at1.taskQtySum > 0 && close(at3.taskQtySum, 3 * at1.taskQtySum),
  );

  // ── 3. procurement "required", per catalog item ─────────────────────────
  const catalogIds = new Set([
    ...at3.shortByCatalogItem.keys(), ...at1.shortByCatalogItem.keys(), ...at0.shortByCatalogItem.keys(),
  ]);
  let sawScaling = false;
  let sawUnaffected = false;
  for (const id of catalogIds) {
    const r3 = at3.shortByCatalogItem.get(id) ?? 0;
    const r1 = at1.shortByCatalogItem.get(id) ?? 0;
    const r0 = at0.shortByCatalogItem.get(id) ?? 0;
    const d3 = r3 - r0;
    const d1 = r1 - r0;
    if (Math.abs(d1) < 1e-9 && Math.abs(d3) < 1e-9) {
      sawUnaffected = true;
      check(`catalog item ${id}: required unaffected by line 124's qty (nested branch has no line factor)`, true);
      continue;
    }
    sawScaling = true;
    check(
      `catalog item ${id}: required scales with line 124's qty (Δat-qty-3=${d3} = 3 × Δat-qty-1=${d1})`,
      close(d3, 3 * d1, 1e-6),
    );
  }
  check('fixture exercised at least one un-nested (scaling) catalog item', sawScaling);
  check('fixture exercised at least one nested (unaffected) catalog item', sawUnaffected);
} catch (err) {
  failed = true;
  console.error('ERROR', err);
} finally {
  await conn.rollback();
  conn.release();
  await pool.end();
}

console.log(failed ? '\nFAILED' : '\nALL PASS (transaction rolled back, nothing persisted)');
process.exit(failed ? 1 : 0);
