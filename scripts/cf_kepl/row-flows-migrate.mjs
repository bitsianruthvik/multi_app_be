/**
 * row-flows-migrate.mjs — one time, for "an order row's flow and field list are its own"
 * (user, 2026-10-10; bomGraph.effectiveFlowOf, flowSpecService).
 *
 *   1. STAMP   every order row (temporary item) with no flow of its own takes its definition's flow
 *              of today — from here on it never follows the definition.
 *   2. RULES   every record gets the rules its OWN flow reads (flowSpecService.syncFlowSpecs):
 *              definitions and catalog items as before; every order row its own. A row of a frozen
 *              or released line gets the list it has TODAY, once (includeLocked) — after this it is
 *              left alone. Flow-made rules no time reads any more are removed.
 *
 *   node scripts/cf_kepl/row-flows-migrate.mjs --company 30005            (dry run: rolled back)
 *   node scripts/cf_kepl/row-flows-migrate.mjs --company 30005 --apply    (commits)
 * Re-running changes nothing.
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
const { syncFlowSpecs } = await import('../../apps/cf_erp/services/flowSpecService.js');

const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const t0 = Date.now();
try {
  await db.beginTransaction();
  const [st] = await db.query(
    `UPDATE cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'temporary'
       JOIN cf_master_records d ON d.id = i.source_definition_id
        SET m.default_flow_id = d.default_flow_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.default_flow_id IS NULL AND d.default_flow_id IS NOT NULL`, [COMPANY]);
  console.log(`1. Order rows stamped with their definition's flow of today: ${st.affectedRows}`);
  const [[none]] = await db.query(
    `SELECT COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL AND i.item_type = 'temporary'
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.default_flow_id IS NULL AND i.source_definition_id IS NOT NULL`, [COMPANY]);
  console.log(`   rows made from a definition that has no flow (they have none either): ${none.n}`);

  const [recs] = await db.query(
    `SELECT m.id, m.record_kind, i.item_type FROM cf_master_records m LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL`, [COMPANY]);
  const tally = { added: 0, removed: 0, madeRequired: 0, kept: 0 };
  const unknown = new Set();
  const ids = recs.map((r) => Number(r.id));
  for (let i = 0; i < ids.length; i += 1500) {
    const r = await syncFlowSpecs(db, c, ids.slice(i, i + 1500), { includeLocked: true });
    tally.added += r.added.filter((a) => !a.madeRequired).length;
    tally.madeRequired += r.added.filter((a) => a.madeRequired).length;
    tally.removed += r.removed.length;
    tally.kept += r.kept.length;
    for (const u of r.unknown) unknown.add(u);
  }
  const rows = recs.filter((r) => r.item_type === 'temporary').length;
  console.log(`2. Records looked at: ${ids.length} (${rows} order rows, ${recs.filter((r) => r.record_kind === 'definition').length} definitions)`);
  console.log(`   rules added on the records whose flow reads the value: ${tally.added}`);
  console.log(`   hand-made optional rules made required: ${tally.madeRequired}`);
  console.log(`   flow-made rules no time reads any more, removed: ${tally.removed}`);
  if (unknown.size) console.log(`   ! values a time reads that are not specifications: ${[...unknown].join(', ')}`);
  const [byKind] = await db.query(
    `SELECT IF(i.item_type = 'temporary', 'order rows', IF(m.record_kind = 'definition', 'definitions', 'catalog items')) AS kind, COUNT(*) AS n
       FROM cf_spec_assignments a JOIN cf_master_records m ON m.id = a.subject_id AND a.subject_type = 'master'
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE a.company_id = ? AND a.deleted_at IS NULL AND a.origin = 'flow' GROUP BY kind`, [COMPANY]);
  console.log(`   flow-made rules now: ${byKind.map((k) => `${k.kind} ${k.n}`).join(', ') || 'none'}`);
  if (APPLY) { await db.commit(); console.log(`COMMITTED  (${((Date.now() - t0) / 1000).toFixed(0)}s)`); } else { await db.rollback(); console.log(`DRY RUN — rolled back. Add --apply to keep it.  (${((Date.now() - t0) / 1000).toFixed(0)}s)`); }
} catch (err) {
  await db.rollback().catch(() => {});
  console.error('ERROR', err.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
