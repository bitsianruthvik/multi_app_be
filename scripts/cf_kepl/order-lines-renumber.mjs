/**
 * order-lines-renumber.mjs — sales order lines numbered 1, 2, 3 … on the orders that already exist
 * (new lines have taken the next number up by one since 2026-10-13; before that they went 10, 20, 30,
 * which people read as a code rather than as "the first line").
 *
 *   node scripts/cf_kepl/order-lines-renumber.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/order-lines-renumber.mjs --company 30005 --apply    (commits)
 *
 * Each order's LIVE lines keep their order and take 1, 2, 3 …. Only cf_sales_order_lines.line_no is
 * written. What was already issued with the old number in its text — a drawing register number
 * (ORDER/L10/MARK), a downloaded file's name — keeps saying what it said.
 *
 * A line's new number is never above its old one (distinct positive numbers, sorted), so writing them
 * lowest first can never meet uq_csol_line_no. One UPDATE per line that moves; a second run moves none.
 */
import { pathToFileURL } from 'url';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };

export async function run(db, companyId, { log = console.log } = {}) {
  const [lines] = await db.query(
    `SELECT l.id, l.order_id, l.line_no, o.code
       FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.company_id = l.company_id AND o.id = l.order_id AND o.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL ORDER BY l.order_id, l.line_no, l.id`, [companyId]);
  let moved = 0; let at = null; let n = 0;
  for (const l of lines) {
    if (l.order_id !== at) { at = l.order_id; n = 0; }
    n += 1;
    if (Number(l.line_no) === n) continue;
    if (Number(l.line_no) < n) throw new Error(`${l.code}: line ${l.line_no} would move UP to ${n} — the lines are not what this expects`);
    await db.query('UPDATE cf_sales_order_lines SET line_no = ? WHERE company_id = ? AND id = ?', [n, companyId, l.id]);
    log(`  ${l.code}: line ${l.line_no} → ${n}`);
    moved += 1;
  }
  log(`${lines.length} lines on ${new Set(lines.map((l) => l.order_id)).size} orders · ${moved} renumbered`);
  return { moved, lines: lines.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const companyId = Number(arg('company'));
  const apply = process.argv.includes('--apply');
  if (!companyId) { console.log('--company <id> is needed'); process.exit(1); }
  const { pool } = await import('../../db.js');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await run(db, companyId);
    if (apply) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
  } catch (e) {
    await db.rollback().catch(() => {});
    console.log(`ERROR — rolled back: ${e.message}`);
  } finally { db.release(); await pool.end(); }
}
