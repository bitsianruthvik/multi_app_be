/**
 * drawings-read-shapes.mjs — plate parts' drawings saved WITHOUT a shape get it read from the file
 * already stored (no re-upload). Until 2026-10-11 a DXF uploaded before the line's cut pieces
 * existed was kept as a plain drawing (geometry_json NULL), so nesting, cut length and the CNC file
 * never saw the true shape. The app now reads such a file by itself the first time it is listed or
 * used (partDrawingService.readMissingShapes); this does it for a whole company at once and says
 * what it found.
 *
 *   node scripts/cf_kepl/drawings-read-shapes.mjs --company 30005                       (dry run: rolled back)
 *   node scripts/cf_kepl/drawings-read-shapes.mjs --company 30005 --order SO260002      (one order)
 *   node scripts/cf_kepl/drawings-read-shapes.mjs --company 30005 --apply               (commits)
 *
 * Per order it prints: drawings looked at, shapes read, files that are not one plate part (and
 * why — they stay plain drawings, with the reason in their warnings), sizes that disagree with the
 * row. Re-running changes nothing. Round trips: one query to find the lines, a fixed number per
 * line (never per row or per drawing), ONE bulk UPDATE per order; a line that is not released and
 * had shapes read then gives its cut plates their cut length and piercings (refreshPlateCuts — a
 * released line's production steps hold their own times, so its cut plates are left alone).
 */
import { pathToFileURL } from 'url';

/** The whole pass on a connection the caller owns (its transaction): → { orders: [...], totals }. */
export async function readShapes(db, { companyId, orderCode = null, log = console.log }) {
  const { lateShapesOfLine, writeShapes } = await import('../../apps/cf_erp/services/partDrawingService.js');
  const { refreshPlateCuts } = await import('../../apps/cf_erp/services/plateCutsService.js');
  const c = { companyId, userId: null };
  const [lines] = await db.query(
    `SELECT l.id, l.line_no, o.id AS order_id, o.code AS order_code, COUNT(*) AS files, SUM(d.geometry_json IS NOT NULL) AS shaped
       FROM cf_part_drawings d
       JOIN cf_sales_order_lines l ON l.id = d.order_line_id AND l.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = l.order_id AND o.deleted_at IS NULL
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.file_kind = 'dxf' AND d.dxf_text IS NOT NULL${orderCode ? ' AND o.code = ?' : ''}
      GROUP BY l.id, l.line_no, o.id, o.code
     HAVING SUM(d.geometry_json IS NULL) > 0
      ORDER BY o.code, l.line_no`,
    orderCode ? [companyId, orderCode] : [companyId],
  );
  const byOrder = new Map();
  for (const l of lines) { if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, { code: l.order_code, lines: [] }); byOrder.get(l.order_id).lines.push(l); }
  const totals = { orders: 0, looked: 0, read: 0, notOnePlate: 0, sizeMismatches: 0, written: 0 };
  const orders = [];
  for (const o of byOrder.values()) {
    const rep = { code: o.code, dxfFiles: 0, alreadyShaped: 0, looked: 0, read: [], notOnePlate: [], sizeMismatches: [], written: 0 };
    const writes = [];
    const touched = [];
    for (const l of o.lines) {
      const late = await lateShapesOfLine(db, companyId, l.id, { persist: false });
      rep.dxfFiles += Number(l.files); rep.alreadyShaped += Number(l.shaped);
      rep.looked += late.looked; rep.read.push(...late.read.map((x) => x.mark)); rep.sizeMismatches.push(...late.sizeMismatches);
      rep.notOnePlate.push(...late.notOnePlate.map((x) => ({ mark: x.mark, why: x.why, known: x.known })));
      writes.push(...late.writes);
      if (late.read.length && !late.line.released) touched.push(l.id);
    }
    await writeShapes(db, companyId, writes);               // one UPDATE for the order
    for (const id of touched) rep.written += (await refreshPlateCuts(db, c, id)).written;
    log(`${rep.code}: ${rep.dxfFiles} DXF files (${rep.alreadyShaped} already had a shape) · ${rep.looked} on plate parts without a shape looked at · ${rep.read.length} shapes read · ${rep.notOnePlate.length} not one plate part · ${rep.sizeMismatches.length} size mismatches · ${rep.written} cut-plate values written`);
    if (rep.read.length) log(`    read: ${rep.read.join(', ')}`);
    for (const x of rep.notOnePlate) log(`    not one plate part — ${x.mark}: ${x.why}${x.known ? ' (already said on the drawing)' : ''}`);
    for (const w of rep.sizeMismatches) log(`    size — ${w}`);
    totals.orders += 1; totals.looked += rep.looked; totals.read += rep.read.length; totals.notOnePlate += rep.notOnePlate.length; totals.sizeMismatches += rep.sizeMismatches.length; totals.written += rep.written;
    orders.push(rep);
  }
  log(`${totals.orders} order${totals.orders === 1 ? '' : 's'} with DXF files lacking a shape · ${totals.looked} looked at · ${totals.read} shapes read · ${totals.notOnePlate} not one plate part · ${totals.sizeMismatches} size mismatches`);
  return { orders, totals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const COMPANY = Number(arg('company'));
  const APPLY = process.argv.includes('--apply');
  if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--order <code>] [--apply]');
  const { pool } = await import('../../db.js');
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await readShapes(db, { companyId: COMPANY, orderCode: arg('order') });
    if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
  } catch (err) {
    await db.rollback().catch(() => {});
    console.error('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
