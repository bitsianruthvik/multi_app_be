/**
 * buying-pr-migrate.mjs — ONE-TIME: give every open order line that has material its REQUISITION
 * (init.sql §56, TM/CF_ERP_BUYING_V2.md), from its CURRENT state, so production data keeps working
 * when Buying v2 goes live. Run it AFTER TM/s56.sql has been applied.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/buying-pr-migrate.mjs --company <id>            dry run: everything is done, counted, and ROLLED BACK
 *   node scripts/cf_kepl/buying-pr-migrate.mjs --company <id> --apply    the same, committed
 *   (reads the database the environment points at: export the TiDB variables first for production)
 *
 * WHAT IT DOES, for the company's open orders (inquiry / quoted / confirmed), in one transaction:
 *   1. every line whose material is known (released, or frozen) and that buys something gets a
 *      requisition, with one line per material at the line's need. A line that already has one is
 *      only brought up to date. Nothing is earmarked and nothing is skipped.
 *   2. what the order already had "for the order as a whole" — holds (stock checks and receipts of
 *      the old flow) and purchase allocations still to come (requested POs included) — is handed to
 *      the requisition lines of that order that need the item, in line-number order, each up to what
 *      it lacks (requisitionService.adoptOrderCover). That is the order the material-ready engine
 *      already used them in, so NO ANSWER CHANGES — and the script proves it: the engine's state and
 *      date of every line are compared before and after, and a difference STOPS an --apply.
 *   What no requisition line needs stays the order's, as it was. A request that the old flow met
 *   wholly from stock left a CANCELLED purchase order behind: that is history and is left alone.
 *
 * IDEMPOTENT: a second run finds the requisitions there and nothing left to hand over.
 * Round trips: fixed (≈ 40), whatever the number of orders, lines or materials.
 */
import { pathToFileURL } from 'node:url';
import { insertRows } from '../../apps/cf_erp/lib/db.js';
import { openLines, lineNeeds, lineReadiness } from '../../apps/cf_erp/services/materialReadyService.js';
import { syncLines, adoptOrderCover } from '../../apps/cf_erp/services/requisitionService.js';

const stateOf = (R) => new Map([...R.byLine].map(([id, r]) => [id, `${r.known ? r.state : 'unknown'}|${r.readyDate ?? ''}`]));

/**
 * The migration, on the connection given (the caller owns the transaction).
 * `apply: false` does everything inside a SAVEPOINT and rolls back to it.
 * Returns the counts, and `changed`: lines whose engine answer differs after (must be empty).
 */
export async function migrate(db, c, { apply = false } = {}) {
  const out = {
    company: c.companyId, apply, openLines: 0, linesWithMaterial: 0, linesWithoutKnownMaterial: 0,
    requisitionsCreated: 0, requisitionsAlreadyThere: 0, requisitionLinesAdded: 0, requisitionLinesChanged: 0,
    holdsHandedOver: 0, holdQuantity: 0, allocationsHandedOver: 0, allocationQuantity: 0,
    orderLevelLeft: { holds: 0, allocations: 0 }, changed: [],
  };
  await db.query('SAVEPOINT buying_pr_migrate');
  try {
    const before = stateOf(await lineReadiness(db, c.companyId, { full: false }));
    const lines = await openLines(db, c.companyId);
    out.openLines = lines.length;
    const needs = await lineNeeds(db, c.companyId, lines);
    const can = lines.filter((l) => needs.get(Number(l.id))?.known && needs.get(Number(l.id)).items.size > 0);
    out.linesWithMaterial = can.length;
    out.linesWithoutKnownMaterial = lines.filter((l) => !needs.get(Number(l.id))?.known).length;
    if (can.length) {
      const lineIds = can.map((l) => Number(l.id));
      const [had] = await db.query('SELECT id, order_line_id FROM cf_requisitions WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]);
      const hadLine = new Set(had.map((r) => Number(r.order_line_id)));
      const fresh = can.filter((l) => !hadLine.has(Number(l.id)));
      await insertRows(db, 'cf_requisitions', ['company_id', 'code', 'order_id', 'order_line_id', 'notes', 'created_by'],
        fresh.map((l) => [c.companyId, `PR-${l.order_code}-${l.line_no}`.slice(0, 140), l.order_id, l.id, 'Raised by the Buying v2 migration from the line\'s state.', c.userId ?? null]));
      out.requisitionsCreated = fresh.length;
      out.requisitionsAlreadyThere = had.length;
      const [prs] = await db.query('SELECT id, order_line_id FROM cf_requisitions WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [c.companyId, lineIds]);
      const synced = await syncLines(db, c, prs, needs);
      out.requisitionLinesAdded = synced.added;
      out.requisitionLinesChanged = synced.changed;
      const adopted = await adoptOrderCover(db, c, [...new Set(can.map((l) => Number(l.order_id)))], { needs });
      Object.assign(out, { holdsHandedOver: adopted.holds, holdQuantity: adopted.holdQuantity ?? adopted.holdQty, allocationsHandedOver: adopted.allocations, allocationQuantity: adopted.allocationQty });
    }
    const [[left]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM cf_stock_reservations v JOIN cf_sales_orders o ON o.id = v.held_for_order_id AND o.status IN ('inquiry','quoted','confirmed')
                WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.pr_line_id IS NULL) AS holds,
              (SELECT COUNT(*) FROM cf_purchase_line_orders a JOIN cf_sales_orders o ON o.id = a.order_id AND o.status IN ('inquiry','quoted','confirmed')
                WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.pr_line_id IS NULL AND a.quantity > a.qty_received) AS allocations`,
      [c.companyId, c.companyId],
    );
    out.orderLevelLeft = { holds: Number(left.holds), allocations: Number(left.allocations) };
    const after = stateOf(await lineReadiness(db, c.companyId, { full: false }));
    for (const [id, was] of before) if (after.get(id) !== was) out.changed.push({ lineId: id, before: was, after: after.get(id) ?? null });
    if (!apply || out.changed.length) await db.query('ROLLBACK TO SAVEPOINT buying_pr_migrate');
    else await db.query('RELEASE SAVEPOINT buying_pr_migrate');
    out.written = apply && !out.changed.length;
    return out;
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT buying_pr_migrate').catch(() => {});
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--company');
  const companyId = at >= 0 ? Number(args[at + 1]) : NaN;
  const apply = args.includes('--apply');
  if (!Number.isInteger(companyId) || companyId <= 0) {
    console.error('usage: node scripts/cf_kepl/buying-pr-migrate.mjs --company <id> [--apply]');
    process.exit(2);
  }
  const { pool } = await import('../../db.js');
  await import('../../apps/cf_erp/services/codegenProvider.js');
  const db = await pool.getConnection();
  let code = 0;
  try {
    const [[schema]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cf_requisitions', 'cf_requisition_lines')");
    if (Number(schema.n) !== 2) throw new Error('init.sql §56 is not applied here (cf_requisitions is missing) — run TM/s56.sql first.');
    await db.beginTransaction();
    const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [companyId]);
    const out = await migrate(db, { companyId, userId: user?.id ?? null }, { apply });
    if (out.written) await db.commit(); else await db.rollback();
    console.log(`Buying v2 migration — company ${companyId} — ${apply ? 'APPLY' : 'DRY RUN (rolled back)'} — host ${process.env.DB_HOST ?? 'localhost'}`);
    console.log(`  open lines                         ${out.openLines}`);
    console.log(`  …with material that is bought      ${out.linesWithMaterial}`);
    console.log(`  …whose material is not known yet   ${out.linesWithoutKnownMaterial}  (not frozen / not released: no requisition yet)`);
    console.log(`  requisitions created               ${out.requisitionsCreated}  (already there: ${out.requisitionsAlreadyThere})`);
    console.log(`  requisition lines added / changed  ${out.requisitionLinesAdded} / ${out.requisitionLinesChanged}`);
    console.log(`  holds handed to requisition lines  ${out.holdsHandedOver}  (quantity ${out.holdQuantity})`);
    console.log(`  PO shares handed over              ${out.allocationsHandedOver}  (quantity ${out.allocationQuantity})`);
    console.log(`  left "for the order as a whole"    ${out.orderLevelLeft.holds} holds, ${out.orderLevelLeft.allocations} PO shares  (no requisition line needs them)`);
    console.log(`  engine answers that changed        ${out.changed.length}${out.changed.length ? '  ← MUST BE 0' : ''}`);
    for (const x of out.changed.slice(0, 20)) console.log(`      line ${x.lineId}: ${x.before} → ${x.after}`);
    if (apply && !out.written) { console.log('  NOTHING WAS WRITTEN: the engine would answer differently for the lines above. Report this before going on.'); code = 1; }
    else console.log(apply ? '  committed.' : '  nothing was written. Add --apply to write it.');
  } catch (e) {
    try { await db.rollback(); } catch { /* the original error is the one that matters */ }
    console.error(`FAILED: ${e.message}`);
    code = 1;
  } finally {
    db.release();
    await pool.end();
  }
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
