/**
 * drawing-mark-all-levels.mjs — every level of an order's structure can carry a DRAWING MARK
 * (user, 2026-10-08: "upload drawings for not just parts but all the levels"). A drawing is matched
 * to its rows by that mark, so a level without the field (on Placebo: the span, "Composite girder",
 * and the girder line) could never get one. Each classification an order row sits in — cut pieces
 * left out, they are worked out — that has no DRAWING_MARK rule in its chain gets one: entered,
 * optional. Nothing is filled in; the Structure grid shows the column for those rows.
 *
 *   node scripts/cf_kepl/drawing-mark-all-levels.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/drawing-mark-all-levels.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
const { cutPlaces } = await import('../../apps/cf_erp/lib/cutPlaces.js');
const db = await pool.getConnection();
try {
  await db.beginTransaction();
  const [[spec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'DRAWING_MARK' AND deleted_at IS NULL", [COMPANY]);
  if (!spec) throw new Error('This company has no DRAWING_MARK specification.');
  const places = await cutPlaces(db, COMPANY);
  const cut = new Set([...(places.plate?.blanksIds ?? []), ...(places.plate?.offcutIds ?? []), ...(places.section?.blanksIds ?? []), ...(places.section?.offcutIds ?? [])].map(Number));
  const [nodes] = await db.query(
    `WITH RECURSIVE up AS (
       SELECT n.id AS seed, n.id, n.parent_id FROM cf_classification_nodes n
        WHERE n.company_id = ? AND n.deleted_at IS NULL
          AND n.id IN (SELECT DISTINCT m.classification_id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'temporary' AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.deleted_at IS NULL)
       UNION ALL
       SELECT up.seed, p.id, p.parent_id FROM up JOIN cf_classification_nodes p ON p.id = up.parent_id)
     SELECT n.id, n.code, n.name,
            MAX(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS has_mark
       FROM up
       JOIN cf_classification_nodes n ON n.id = up.seed
       LEFT JOIN cf_spec_assignments a ON a.company_id = ? AND a.subject_type = 'classification' AND a.subject_id = up.id AND a.specification_id = ? AND a.deleted_at IS NULL
      GROUP BY n.id, n.code, n.name ORDER BY n.code`,
    [COMPANY, COMPANY, COMPANY, spec.id]);
  const missing = nodes.filter((n) => !Number(n.has_mark) && !cut.has(Number(n.id)));
  for (const n of missing) {
    await db.query("INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule) VALUES (?, ?, 'classification', ?, 'item', 0, 1, 'entered')", [COMPANY, spec.id, n.id]);
    console.log(`  + DRAWING_MARK on ${n.code} (${n.name})`);
  }
  console.log(`${nodes.length} levels used by order rows · ${missing.length} given a drawing mark`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
