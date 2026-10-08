/**
 * plate-cuts-backfill.mjs — nests saved before plateCutsService (2026-10-08) give their cut plates
 * the CNC inputs they imply: cut length less common lines, one piercing per piece. Lines already
 * released are left alone (their production steps hold their own times).
 *
 *   node scripts/cf_kepl/plate-cuts-backfill.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/plate-cuts-backfill.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
const { cutPlaces } = await import('../../apps/cf_erp/lib/cutPlaces.js');
const { writePlateCuts } = await import('../../apps/cf_erp/services/plateCutsService.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
try {
  await db.beginTransaction();
  const places = await cutPlaces(db, COMPANY);
  const plateNodes = [...(places.plate?.blanksIds ?? [])];
  if (!plateNodes.length) throw new Error('No place is set for cut plates (Setup › Cutting).');
  const [lines] = await db.query(
    `SELECT DISTINCT l.order_line_id AS id, ol.line_no, o.code AS order_code FROM cf_plate_lots l
       JOIN cf_sales_order_lines ol ON ol.id = l.order_line_id AND ol.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = ol.order_id AND o.deleted_at IS NULL
       LEFT JOIN cf_production_releases r ON r.order_line_id = l.order_line_id AND r.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.kind = 'plate' AND r.id IS NULL`, [COMPANY]);
  let total = 0;
  for (const line of lines) {
    const [rows] = await db.query(
      `SELECT m.id, UPPER(s.code) AS code, v.value_number FROM cf_master_records m
         JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL AND i.owner_order_line_id = ?
         LEFT JOIN cf_spec_values v ON v.company_id = m.company_id AND v.subject_type = 'master' AND v.subject_id = m.id AND v.deleted_at IS NULL
         LEFT JOIN cf_specifications s ON s.id = v.specification_id AND s.code IN ('LENGTH', 'WIDTH')
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.classification_id IN (?)`, [line.id, COMPANY, plateNodes]);
    const cps = new Map();
    for (const r of rows) {
      if (!cps.has(r.id)) cps.set(r.id, { id: r.id, steel: {} });
      if (r.code === 'LENGTH') cps.get(r.id).steel.length = Number(r.value_number);
      if (r.code === 'WIDTH') cps.get(r.id).steel.width = Number(r.value_number);
    }
    const out = await writePlateCuts(db, c, line.id, [...cps.values()]);
    total += out.written;
    console.log(`  ${line.order_code} line ${line.line_no}: ${cps.size} cut plates, ${out.nested} nested, ${out.written} values written, ${Math.round(out.shared)} mm of cut shared`);
  }
  console.log(`${lines.length} nested lines not yet released · ${total} values written`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
