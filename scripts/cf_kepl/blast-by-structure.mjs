/**
 * blast-by-structure.mjs — blasting time by structure size (user, 2026-10-10: "big structure means a
 * girder segment and small structure means a splice or a part").
 *
 * BLAST_TIME (on Automatic blasting) becomes Structure (the piece's variant) × Coats → min:
 *   Girder segment (big)   1 coat 20, 2 coats 35, 3 coats 45   (the sheet's 20 + 15 + 10 per pass)
 *   every small structure  10, whatever the coats              (Plate part, Profile part, Diaphragm,
 *                                                               Bottom Lateral Bracings, Seismic Stoppers)
 * and the BLAST time adds the 15–20 min of manual blasting only on a girder segment.
 *
 *   node scripts/cf_kepl/blast-by-structure.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/blast-by-structure.mjs --company 30005 --apply    (commits)
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
const { updateChart, setChartValue, listCharts } = await import('../../apps/cf_erp/services/chartService.js');
const { updateTimingRule, listTimingRules } = await import('../../apps/cf_erp/services/operationService.js');

const BIG = 'Girder segment';
const SMALL = ['Plate part', 'Profile part', 'Diaphragm', 'Bottom Lateral Bracings', 'Seismic Stoppers'];
const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
try {
  await db.beginTransaction();
  const [[chart]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'BLAST_TIME' AND data_type = 'table' AND deleted_at IS NULL", [COMPANY]);
  const [[type]] = await db.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope = 'machine' AND deleted_at IS NULL AND name = 'Automatic blasting'", [COMPANY]);
  if (!chart || !type) throw new Error('BLAST_TIME or Automatic blasting not found');
  const [nodes] = await db.query("SELECT name FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND scope <> 'machine' AND depth = 2 AND name IN (?)", [COMPANY, [BIG, ...SMALL]]);
  const have = new Set(nodes.map((n) => n.name));
  const small = SMALL.filter((n) => have.has(n));
  if (!have.has(BIG)) throw new Error(`No variant "${BIG}"`);
  // The old rows (by coats alone) go everywhere, so the new column starts clean.
  await db.query('UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND deleted_at IS NULL', [COMPANY, chart.id]);
  await updateChart(db, c, chart.id, { name: 'Blasting time', resultUnit: 'min', mode: 'step_up', inputs: [{ level: 'VARIANT' }, { field: 'COATS' }] });
  const rows = [[BIG, 1, 20], [BIG, 2, 35], [BIG, 3, 45], ...small.flatMap((n) => [[n, 1, 10], [n, 2, 10], [n, 3, 10]])];
  await setChartValue(db, c, { type: 'classification', id: type.id }, chart.id, rows);
  const shown = (await listCharts(db, COMPANY, { type: 'classification', id: type.id })).find((x) => x.specId === chart.id);
  console.log(`BLAST_TIME: ${shown.axes.map((a) => a.label).join(' × ')} → ${shown.resultUnit}, ${shown.rows.length} rows`);
  console.log(`   big: ${BIG} 20 / 35 / 45;  small (10): ${small.join(', ')}`);

  const [[op]] = await db.query("SELECT id FROM cf_operations WHERE company_id = ? AND code = 'BLAST' AND deleted_at IS NULL", [COMPANY]);
  const rule = (await listTimingRules(db, COMPANY, op.id))[0];
  await updateTimingRule(db, c, rule.id, { workExpression: `machine.BLAST_TIME + IF(item.variant = "${BIG}", 17.5, 0)` });
  const after = (await listTimingRules(db, COMPANY, op.id))[0];
  console.log(`BLAST time: ${after.work.display ?? after.work.expression}`);
  console.log(`   stored:  ${after.work.expression}`);
  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('DRY RUN — rolled back. Add --apply to keep it.'); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message, err.problems ? JSON.stringify(err.problems) : '');
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
