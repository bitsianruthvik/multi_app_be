/**
 * flow.mjs — take the built order the rest of the way.
 *
 * Usage: node scripts/kepl/flow.mjs <companyId> <orderId> [--apply]
 *
 * confirm -> raise procurement -> receive the delivery -> raise production.
 *
 * Each step calls the SAME service the screen calls, and each gate is checked
 * rather than forced. If a gate refuses, that refusal is the finding — forcing
 * past it would produce an order that looks finished and is not, which is the
 * one outcome this exercise is meant to rule out.
 *
 * The receipt books every plate AT THE SIZE THE NESTING ASKED FOR. That is the
 * whole point of doing it here rather than by hand: consumption matches stock
 * by size, so a delivery booked as unsized plate would satisfy procurement and
 * then fail to feed a single cutting task.
 */

import { pool } from '../../db.js';
import { orderShortfall } from '../../apps/fab_erp/services/procurementService.js';
import { raiseProcurement, receiveAgainstOrder, purchaseOrderLines } from '../../apps/fab_erp/services/procurementOrderService.js';
import { ensureProductionOrder, approveProductionOrder } from '../../apps/fab_erp/services/productionOrderService.js';
import { checkOrderNesting, blockingIssues } from '../../apps/fab_erp/services/nestingIntegrityService.js';
import { missingFieldsForOrder } from '../../apps/fab_erp/services/itemFieldService.js';
import { confirmOrder } from '../../apps/fab_erp/services/orderReadinessService.js';

const args = process.argv.slice(2);
const [companyId, orderId] = args.filter((a) => /^\d+$/.test(a)).map(Number);
const apply = args.includes('--apply');
if (!companyId || !orderId) {
  console.error('Usage: node scripts/kepl/flow.mjs <companyId> <orderId> [--apply]');
  process.exit(1);
}
const log = (m) => console.log(m);
/** Above this, a delivery is booked as one measured lot rather than piece by piece. */
const BULK_ABOVE = 200;

try {
  // ── gates, before anything is committed anywhere ──────────────────────────
  const nesting = await checkOrderNesting(companyId, orderId);
  const blocking = blockingIssues(nesting);
  log(`\n1. nesting      ${blocking.length ? `${blocking.length} BLOCKING` : 'clean'} `
    + `(${nesting.checked} links, advisory ${nesting.issues.length - blocking.length})`);
  if (blocking.length) { for (const i of blocking.slice(0, 5)) log(`     ${i.message}`); process.exit(1); }

  const readiness = await missingFieldsForOrder(companyId, orderId);
  log(`2. fields       ${readiness.itemsShort ? `${readiness.itemsShort} SHORT` : 'complete'} `
    + `(${readiness.itemsChecked} items)`);
  if (readiness.itemsShort) process.exit(1);

  const short = await orderShortfall(companyId, orderId);
  log('3. shortfall');
  for (const l of short.lines) {
    log(`     ${String(l.code).padEnd(14)} need ${String(l.required).padStart(6)}  `
      + `have ${String(l.available).padStart(4)}  buy ${String(l.short).padStart(6)}   `
      + (l.sizes ?? []).map((s) => `${s.width}x${s.length}:${s.required}`).join(' '));
  }
  if (!apply) { log('\nGates pass. Nothing written. Re-run with --apply.\n'); await pool.end(); process.exit(0); }

  /**
   * CONFIRM IS LAST, NOT FIRST.
   *
   * Confirming reads as a commitment to the customer, so the wizard refuses it
   * until every preparation step is done — and two of those steps are the ones
   * below. Raising procurement first looked backwards and is not: the project
   * tree is built BY raising the production order, so buying and committing to
   * make both happen while the order is still a draft, and the draft is what
   * says "still in the wizard". Confirm closes it.
   */

  // ── 4. purchase orders ────────────────────────────────────────────────────
  /**
   * THE SUPPLIER HAS TO BE NAMED, and raiseProcurement is right to insist.
   *
   * Called with no lines it defaults every shortfall to `supplierId: null` and
   * then skips all of them — "a purchase order with no supplier is not a draft
   * to fix later, it is a document that cannot be sent". So the caller picks.
   * One mill supplies all of it here, which is what a plate order of this size
   * would actually be.
   */
  let [[supplier]] = await pool.query(
    `SELECT id, name FROM fab_suppliers WHERE company_id = ? AND deleted_at IS NULL
       AND name LIKE 'Mill Supply%' LIMIT 1`,
    [companyId],
  );
  if (!supplier) {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) n FROM fab_suppliers WHERE company_id = ?', [companyId],
    );
    const [ins] = await pool.query(
      `INSERT INTO fab_suppliers (company_id, code, name, lead_time_days, currency, payment_terms)
       VALUES (?,?,?,?,?,?)`,
      [companyId, `SUP-${String(n + 1).padStart(4, '0')}`, 'Mill Supply — Plate & Sections',
        30, 'INR', '45 days'],
    );
    supplier = { id: ins.insertId, name: 'Mill Supply — Plate & Sections' };
    log(`   supplier created: ${supplier.name} (${supplier.id})`);
  }

  /**
   * RAISING IS NOT IDEMPOTENT, so this asks first.
   *
   * raiseProcurement creates a purchase order every time it is called; it has
   * no notion of "already raised". Re-running this script after a later step
   * failed therefore ordered the whole 692 tonnes a second time — which is
   * exactly what happened, and is the kind of mistake that is embarrassing on a
   * demo and expensive anywhere else. An open PO already sourced from this
   * sales order is the one to receive against.
   */
  const [already] = await pool.query(
    `SELECT id, order_number FROM fab_orders
      WHERE company_id = ? AND order_type = 'purchase' AND source_order_id = ?
        AND status <> 'cancelled' AND deleted_at IS NULL
      ORDER BY id`,
    [companyId, orderId],
  );
  let poIds;
  if (already.length) {
    poIds = already.map((p) => p.id);
    log(`4. procurement  already raised: ${already.map((p) => p.order_number).join(', ')}`);
  } else {
    const po = await raiseProcurement(companyId, orderId, {
      lines: short.lines.filter((l) => l.short > 0).map((l) => ({
        catalogItemId: l.catalogItemId, qty: l.short, supplierId: supplier.id,
      })),
    });
    poIds = (po.orders ?? []).map((p) => p.id);
    log(`4. procurement  ${poIds.length} purchase order(s), ${(po.skipped ?? []).length} skipped`);
    for (const p of po.orders ?? []) log(`     ${p.orderNumber}  ${p.supplierName}  lines ${p.lineCount}`);
    if (po.skipped?.length) for (const s of po.skipped.slice(0, 5)) log(`     skipped: ${JSON.stringify(s)}`);
  }

  // ── 5. receive, at the sizes the nesting asked for ────────────────────────
  // The raw-material yard of the order's own plant, not just the first area in
  // the company — the machine WIP areas are stock locations too, and plate
  // delivered into one of those would be standing at a machine on arrival.
  const [[salesOrder]] = await pool.query('SELECT plant_id FROM fab_orders WHERE id = ?', [orderId]);
  const [[area]] = await pool.query(
    `SELECT id, plant_id FROM fab_stock_locations
      WHERE company_id = ? AND deleted_at IS NULL AND plant_id = ?
        AND code NOT LIKE 'WIP-%' AND code NOT LIKE 'MACH-%'
      ORDER BY id LIMIT 1`,
    [companyId, salesOrder?.plant_id ?? null],
  );
  if (!area) throw new Error('No raw-material stock area on this order\'s plant to receive into');
  for (const poId of poIds) {
    const lines = await purchaseOrderLines(companyId, poId);
    const payload = {
      plant_id: area.plant_id,
      stock_location_id: area.id,
      // The ledger's txn_date is NOT NULL and receiveStock passes this straight
      // through, so an omitted delivery date is a constraint error at the very
      // last statement — after the pieces are written. A delivery has a date.
      received_date: new Date().toISOString().slice(0, 10),
      notes: 'KEPL ROB60 mill delivery',
      lines: [],
    };
    for (const l of lines) {
      const qty = Number(l.qty ?? l.qty_ordered ?? 0) - Number(l.qty_received ?? 0);
      if (qty <= 0) continue;
      /**
       * ONE STOCK PIECE PER PLATE — but a fastener is not a plate.
       *
       * A plate is an individual thing: it gets cut, it gets a heat number, and
       * consumption matches it by size, so each one has to exist as its own
       * piece or the nesting cannot draw the right one. Studs are counted, not
       * identified; booking 14,424 of them as 14,424 rows would put more rows
       * in the stock ledger than the whole rest of the order and buy nothing.
       * The line is the boundary: bulk items arrive as one measured lot.
       */
      /**
       * THE SIZES COME FROM THE NESTING, NOT FROM THE PO LINE.
       *
       * A purchase line is one row per catalog item — "20 of MS Plate 12mm" —
       * because that is what you buy from a mill. It does not carry a size,
       * and the 20 are not all the same: this order needs 16 at 2300 x 12050
       * and 4 at 2250 x 12050. Booking them off the line would put twenty
       * size-less plates on the shelf, procurement would read as satisfied, and
       * then not one cutting task would find a plate it could use, because
       * consumption matches on size. So the receipt is built from the
       * shortfall's own size breakdown, which is what nesting decided.
       */
      const individually = qty <= BULK_ABOVE;
      const sizes = (short.lines.find((s) => s.catalogItemId === Number(l.catalog_item_id))?.sizes ?? [])
        .filter((s) => s.sized && s.required > 0);
      const pieces = [];
      if (!individually) {
        pieces.push({ qty, batch_no: 'KEPL-ROB60-BULK' });
      } else if (sizes.length) {
        let n = 0;
        for (const s of sizes) {
          for (let i = 0; i < Math.round(s.required); i++) {
            pieces.push({
              qty: 1, length_mm: s.length, width_mm: s.width,
              heat_no: `KEPL-${String(++n).padStart(4, '0')}`,
            });
          }
        }
      }
      if (!pieces.length) {
        log(`     WARNING: no size breakdown for line ${l.id} (${l.code}) — booking unsized`);
        pieces.push({ qty });
      }
      // The sizes must add up to what is being received, or the shelf and the
      // line disagree from the first day.
      const pieceQty = pieces.reduce((a, p) => a + Number(p.qty), 0);
      if (Math.abs(pieceQty - qty) > 0.001) {
        throw new Error(`line ${l.id} (${l.code}): ${pieceQty} pieces against ${qty} ordered`);
      }
      payload.lines.push({ line_id: l.id, qty, pieces });
    }
    if (!payload.lines.length) { log(`5. PO ${poId}: nothing outstanding`); continue; }
    const grn = await receiveAgainstOrder(companyId, poId, payload);
    log(`5. received     PO ${grn.orderNumber}: ${grn.qtyTotal} pieces on ${grn.lines.length} lines `
      + `-> ${grn.poStatus}, tasks cleared ${grn.tasksCleared.length}`);
  }

  // ── 6. production, which is also what builds the project tree ─────────────
  const mo = await ensureProductionOrder(companyId, orderId, {});
  log(`6. production   ${mo.orderNumber ?? mo.order_number} (${mo.productionOrderId ?? mo.id}) `
    + `created=${mo.created} tasks=${mo.tasks ?? mo.taskCount ?? '?'}`);
  const appr = await approveProductionOrder(companyId, mo.productionOrderId ?? mo.id);
  log(`7. approved     ${JSON.stringify(appr).slice(0, 200)}`);

  // ── 8. confirm ────────────────────────────────────────────────────────────
  const [[before]] = await pool.query('SELECT status FROM fab_orders WHERE id = ?', [orderId]);
  if (before.status === 'draft') {
    await confirmOrder(companyId, orderId);
    log('8. confirmed');
  } else {
    log(`8. already ${before.status}`);
  }

  const [[fin]] = await pool.query('SELECT status, progress_pct FROM fab_orders WHERE id = ?', [orderId]);
  log(`\n   sales order is now ${fin.status} (${fin.progress_pct}%)\n`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  await pool.end();
}
