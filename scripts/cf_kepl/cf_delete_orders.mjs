/**
 * cf_delete_orders.mjs — soft-deletes whole sales orders that were never real
 * (trial orders), every revision of each, with everything they own:
 *   the order rows, their lines, the lines' temporary items (rows, cut plates —
 *   values, rules and BOMs with them), locked pieces (cf_order_pieces), plate
 *   lots and their placements, and reservations held for the lines.
 *
 * It REFUSES an order that has a live production release or a stock movement:
 * that order has history, so it should be cancelled in the app, not erased.
 *
 * Nothing is hard-deleted — every row only gets deleted_at, so TiDB can still
 * give it back. Everything is set-based (a few dozen round trips per order).
 *
 *   CF_BRIDGE_COMPANY=30005 node scripts/cf_kepl/cf_delete_orders.mjs SO-20260924-0002 SO-20260926-0001
 *   … add --commit to mean it (without it: done inside a transaction, counted, rolled back)
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { deleteTemporaryItems } = await imp('apps/cf_erp/services/treeCopyService.js');

const COMMIT = process.argv.includes('--commit');
const CODES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 0) || null };
if (!CODES.length) { console.log('Name the order codes to delete.'); process.exit(1); }

const conn = await pool.getConnection();
const q = async (sql, args) => (await conn.query(sql, args))[0];
const hasColumn = async (table, col) => Number((await q(
  'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, col]))[0].n) > 0;

let failed = false;
try {
  await conn.beginTransaction();
  const reservationsByLine = await hasColumn('cf_stock_reservations', 'order_line_id');
  console.log(`company ${COMPANY} — ${COMMIT ? 'COMMIT' : 'dry run (rolled back)'}`);

  for (const code of CODES) {
    const orders = await q('SELECT id, revision, status FROM cf_sales_orders WHERE company_id = ? AND code = ? AND deleted_at IS NULL FOR UPDATE', [COMPANY, code]);
    if (!orders.length) { console.log(`\n${code}: not found (or already deleted) — skipped`); continue; }
    const orderIds = orders.map((o) => o.id);
    const lines = await q('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL', [COMPANY, orderIds]);
    const lineIds = lines.map((l) => l.id);
    console.log(`\n${code}: ${orders.map((o) => `rev ${o.revision} [${o.status}]`).join(', ')} — ${lineIds.length} line(s)`);

    const [{ n: releases }] = await q('SELECT COUNT(*) AS n FROM cf_production_releases WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL', [COMPANY, orderIds]);
    const [{ n: moves }] = await q('SELECT COUNT(*) AS n FROM cf_stock_movements WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL', [COMPANY, orderIds]);
    if (Number(releases) || Number(moves)) {
      console.log(`   REFUSED — ${releases} live release(s), ${moves} stock movement(s). Cancel it in the app instead.`);
      failed = true;
      continue;
    }

    const count = {};
    if (lineIds.length) {
      const items = (await q(
        "SELECT master_id FROM cf_item_details WHERE company_id = ? AND owner_order_line_id IN (?) AND item_type = 'temporary' AND deleted_at IS NULL",
        [COMPANY, lineIds])).map((r) => r.master_id);
      count.temporaryItems = await deleteTemporaryItems(conn, c, items);

      const lots = (await q('SELECT id FROM cf_plate_lots WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [COMPANY, lineIds])).map((r) => r.id);
      count.placements = lots.length
        ? (await q('UPDATE cf_nest_placements SET deleted_at = NOW() WHERE company_id = ? AND plate_lot_id IN (?) AND deleted_at IS NULL', [COMPANY, lots])).affectedRows : 0;
      count.plateLots = lots.length
        ? (await q('UPDATE cf_plate_lots SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, lots])).affectedRows : 0;
      count.pieces = (await q('UPDATE cf_order_pieces SET deleted_at = NOW() WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [COMPANY, lineIds])).affectedRows;
      if (reservationsByLine) {
        count.reservations = (await q('UPDATE cf_stock_reservations SET deleted_at = NOW() WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [COMPANY, lineIds])).affectedRows;
      }
      count.lines = (await q('UPDATE cf_sales_order_lines SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, lineIds])).affectedRows;
    }
    count.orderRows = (await q('UPDATE cf_sales_orders SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [COMPANY, orderIds])).affectedRows;
    console.log('   ' + Object.entries(count).map(([k, v]) => `${k} ${v}`).join(' · '));
  }

  if (COMMIT && !failed) { await conn.commit(); console.log('\nCommitted.'); }
  else { await conn.rollback(); console.log(COMMIT ? '\nRolled back — an order was refused, so nothing was written.' : '\nDry run — rolled back. Add --commit to mean it.'); }
} catch (e) {
  await conn.rollback();
  console.error('\nFAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
