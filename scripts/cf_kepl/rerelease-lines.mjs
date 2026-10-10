/**
 * rerelease-lines.mjs — takes every released line back and releases it again, so its steps and
 * their time estimates are the flows' and charts' of TODAY (a release copies its estimates when it
 * is made; user, 2026-10-10: "re-release the KEPL lines so the new times show").
 *
 * A step that was started with nothing reported yet is carried to its new step (same piece code and
 * operation) with its start, machine, events and work session. A step with quantities reported, or
 * material already issued, stops the run — that release is not taken back.
 *
 *   node scripts/cf_kepl/rerelease-lines.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/rerelease-lines.mjs --company 30005 --apply    (commits)
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { releaseLine, unrelease } = await import('../../apps/cf_erp/services/releaseService.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const minutes = async (releaseId) => {
  const [rows] = await db.query(
    `SELECT o.code, COUNT(*) AS steps, SUM(s.est_minutes IS NOT NULL) AS timed, ROUND(SUM(COALESCE(s.est_minutes, 0)) / 60) AS hours
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_operations o ON o.id = s.operation_id
      WHERE pi.release_id = ? AND s.deleted_at IS NULL GROUP BY o.code ORDER BY o.code`, [releaseId]);
  return rows;
};
try {
  await db.beginTransaction();
  const [releases] = await db.query(
    `SELECT r.id, r.order_line_id, r.finished_area_id, o.code, l.line_no FROM cf_production_releases r
       JOIN cf_sales_order_lines l ON l.id = r.order_line_id JOIN cf_sales_orders o ON o.id = r.order_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY r.id`, [COMPANY]);
  const [started] = await db.query(
    `SELECT s.id, s.operation_id, s.machine_id, s.started_at, s.state, s.qty_good, s.qty_scrap, pi.code AS piece, o.code AS op
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND s.deleted_at IS NULL AND (s.state <> 'pending' OR s.started_at IS NOT NULL OR s.qty_good > 0 OR s.qty_scrap > 0)`, [COMPANY]);
  for (const s of started) {
    if (s.state !== 'in_progress' || Number(s.qty_good) > 0 || Number(s.qty_scrap) > 0) throw new Error(`${s.piece} ${s.op} is ${s.state} with ${Number(s.qty_good)} good — work has been reported, so its release is not taken back.`);
    await db.query("UPDATE cf_production_steps SET state = 'pending', started_at = NULL WHERE id = ?", [s.id]);
  }
  const before = new Map();
  for (const r of releases) { before.set(r.order_line_id, await minutes(r.id)); await unrelease(db, c, r.id); }
  console.log(`Taken back: ${releases.map((r) => `${r.code} line ${r.line_no}`).join(', ')}  (${lap()})`);
  for (const r of releases) {
    await releaseLine(db, c, r.order_line_id, { finishedAreaId: r.finished_area_id });
    const [[rel]] = await db.query('SELECT id FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, r.order_line_id]);
    const now = await minutes(rel.id);
    const was = new Map(before.get(r.order_line_id).map((x) => [x.code, x]));
    console.log(`\n${r.code} line ${r.line_no}: release ${rel.id}  (${lap()})`);
    console.log('   operation            steps  with a time   hours now   (hours before)');
    for (const x of now) console.log(`   ${x.code.padEnd(18)} ${String(x.steps).padStart(6)} ${String(x.timed).padStart(12)} ${String(x.hours).padStart(11)}   (${was.get(x.code)?.hours ?? '—'})`);
  }
  for (const s of started) {
    const [[ns]] = await db.query(
      `SELECT s.id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND pi.code = ? AND s.operation_id = ? ORDER BY s.sequence LIMIT 1`, [COMPANY, s.piece, s.operation_id]);
    if (!ns) throw new Error(`${s.piece} ${s.op}: no such step after re-release — its start cannot be carried over.`);
    await db.query("UPDATE cf_production_steps SET state = 'in_progress', started_at = ?, machine_id = ? WHERE id = ?", [s.started_at, s.machine_id, ns.id]);
    await db.query('UPDATE cf_step_events SET step_id = ? WHERE company_id = ? AND step_id = ?', [ns.id, COMPANY, s.id]);
    await db.query('UPDATE cf_work_sessions SET step_id = ? WHERE company_id = ? AND step_id = ?', [ns.id, COMPANY, s.id]);
    console.log(`\nCarried over: ${s.piece} ${s.op}, started ${new Date(s.started_at).toISOString()} → step ${ns.id}`);
  }
  if (APPLY) { await db.commit(); console.log(`\nCOMMITTED  (${lap()})`); } else { await db.rollback(); console.log(`\nDRY RUN — rolled back. Add --apply to keep it.  (${lap()})`); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems).slice(0, 2000) : '');
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
