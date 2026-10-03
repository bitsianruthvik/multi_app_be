/**
 * refresh-cut-pieces.mjs — runs cutPlateService.refreshCutPieces on one order
 * line: what every Structure save does. Since 2026-10-03 that also fills a cut
 * piece's steel (IMPACT_CLASS…) its part was given after the piece was made.
 *
 *   node scripts/cf_kepl/refresh-cut-pieces.mjs --company 30005 --line 240001           (dry run: rolled back)
 *   node scripts/cf_kepl/refresh-cut-pieces.mjs --company 30005 --line 240001 --apply   (commits)
 *
 * Prints what the refresh said. A frozen line is left alone (refreshCutPieces refuses).
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { refreshCutPieces } from '../../apps/cf_erp/services/cutPlateService.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const LINE = Number(arg('line'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY) || !Number.isInteger(LINE)) throw new Error('Usage: --company <id> --line <order line id> [--apply]');

const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[line]] = await db.query(
    'SELECT l.id, l.line_no, o.code FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL',
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`No line ${LINE} in company ${COMPANY}.`);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const out = await refreshCutPieces(db, { companyId: COMPANY, userId: user?.id ?? null, canManage: true, isAdmin: false }, LINE);
  console.log(`${line.code} line ${line.line_no}: ${out.reason ?? (out.made ? 'made' : '?')} — ${out.message ?? ''}`);
  console.log('summary', JSON.stringify(out.summary ?? {}));
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback();
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
