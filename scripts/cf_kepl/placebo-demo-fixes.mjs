/**
 * placebo-demo-fixes.mjs — the three setup fixes found in the placebo_sandbox dry run (2026-10-30), for a company
 * (user, 2026-10-30: "apply the same three fixes to production Placebo too").
 *
 *   1. E250 plates the RDSO parts need: BR (12, 16, 18, 20, 25, 40, 50 mm) and A (8, 10, 16 mm), 2500 x 12000, as catalog
 *      items under PLATE (the grade rule is 'exact': a BR piece is never cut from a BO plate). Existing codes are skipped.
 *   2. Coding rule CFPC-SEGMENT ("Released piece of a kind coded by CFTMP-SEGMENT") gets item.shortName before piece.seq:
 *      without it two different segment-class children of one parent (Lifting beam, Bearing assembly) got the same
 *      code (SO…-CG1-1 twice) and freeze refused the line. Codes already written are not touched.
 *   3. Standard RDSO/B-1623: a throwaway order line from its current version gets section bars on its 5 section parts,
 *      flows on the 14 rows without one and the values freeze asked for; the line is saved as the standard's next
 *      version; the throwaway order (code STDFIX-B1623-<time>, no SO number used) is deleted. Then a SECOND throwaway
 *      line from the new version is checked: it must freeze with nothing to fix (rolled back, nothing kept).
 *
 *   node scripts/cf_kepl/placebo-demo-fixes.mjs --company 30005            (dry run: everything in one transaction, rolled back)
 *   node scripts/cf_kepl/placebo-demo-fixes.mjs --company 30005 --apply
 */
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!Number.isInteger(COMPANY)) throw new Error('Usage: --company <id> [--apply]');

const { pool } = await import('../../db.js');
await import('../../apps/cf_erp/services/codegenProvider.js');
const { createItem, updateRecord } = await import('../../apps/cf_erp/services/masterRecordService.js');
const { createOrder, deleteOrder } = await import('../../apps/cf_erp/services/salesOrderService.js');
const { addLineFromStandard, saveLineToStandard } = await import('../../apps/cf_erp/services/standardDrawingService.js');
const { applyBomChanges } = await import('../../apps/cf_erp/services/bomChangeService.js');
const { writeLineValues } = await import('../../apps/cf_erp/services/orderValuesService.js');
const { withCutPieces } = await import('../../apps/cf_erp/services/cutPlateService.js');
const { saveExecutionPlan } = await import('../../apps/cf_erp/services/executionPlanService.js');
const { lockPlan } = await import('../../apps/cf_erp/services/lockService.js');

const target = process.env.DB_HOST && !/localhost|127\.0\.0\.1/.test(process.env.DB_HOST) ? 'PRODUCTION' : 'local';
console.log(`${target} — company ${COMPANY}${APPLY ? ' — APPLY' : ' — dry run (rolled back)'}`);
const db = await pool.getConnection();
const c = { companyId: COMPANY, userId: null };
const one = async (sql, p) => (await db.query(sql, p))[0][0];
try {
  await db.beginTransaction();

  // ── 1. plates ──
  const plateNode = await one("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = 'PLATE' AND deleted_at IS NULL", [COMPANY]);
  if (!plateNode) throw new Error('No PLATE classification');
  for (const [t, imp] of [[8, 'A'], [10, 'A'], [12, 'BR'], [16, 'BR'], [16, 'A'], [18, 'BR'], [20, 'BR'], [25, 'BR'], [40, 'BR'], [50, 'BR']]) {
    const code = `PL-${t}X2500X12000-E250${imp}`;
    if (await one('SELECT id FROM cf_master_records WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code])) { console.log('  plate exists', code); continue; }
    const r = await createItem(db, c, { name: `MS Plate ${t} x 2500 x 12000 E250 ${imp}`, shortName: 'PL', classificationId: plateNode.id, trackedBy: 'batch', uom: 'nos', sourcing: 'stock', status: 'active',
      values: [{ specCode: 'GRADE', value: 'E250' }, { specCode: 'IMPACT_CLASS', value: imp }, { specCode: 'THICKNESS', value: String(t) }, { specCode: 'WIDTH', value: '2500' }, { specCode: 'LENGTH', value: '12000' }] });
    if (r.code !== code) throw new Error(`plate code ${r.code}, expected ${code}`);
    console.log('  plate', r.id, r.code);
  }

  // ── 2. coding rule ──
  const scheme = await one("SELECT id FROM cf_code_schemes WHERE company_id = ? AND code = 'CFPC-SEGMENT' AND deleted_at IS NULL", [COMPANY]);
  const has = scheme && await one("SELECT id FROM cf_code_scheme_segments WHERE company_id = ? AND scheme_id = ? AND token_key = 'item.shortName' AND deleted_at IS NULL", [COMPANY, scheme.id]);
  if (!scheme) console.log('  no CFPC-SEGMENT rule — skipped');
  else if (has) console.log('  CFPC-SEGMENT already has item.shortName');
  else {
    const [u] = await db.query("UPDATE cf_code_scheme_segments SET sort_order = 4 WHERE company_id = ? AND scheme_id = ? AND token_key = 'piece.seq' AND sort_order = 3 AND deleted_at IS NULL", [COMPANY, scheme.id]);
    if (u.affectedRows !== 1) throw new Error('CFPC-SEGMENT is not parent.code - piece.seq as expected');
    await db.query("INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, token_key, transform, is_required) VALUES (?, ?, 3, 'token', 'item.shortName', 'upper', 1)", [COMPANY, scheme.id]);
    console.log('  CFPC-SEGMENT: parent.code - item.shortName piece.seq');
  }

  // ── 3. the standard ──
  const cust = await one("SELECT id FROM cf_parties WHERE company_id = ? AND is_customer = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const throwaway = async (tag) => {
    const o = await createOrder(db, c, { orderType: 'customer', customerId: cust.id, code: `STDFIX-B1623-${tag}-${Date.now() % 100000}`, title: 'Throwaway: RDSO/B-1623 standard fix (deleted by the script)' });
    const r = await addLineFromStandard(db, c, o.id, { number: 'RDSO/B-1623', quantity: 1 });
    return { orderId: o.id, lineId: r.fromStandard.lineId, versionNo: r.fromStandard.versionNo };
  };
  const t1 = await throwaway('A');
  console.log(`  throwaway line ${t1.lineId} from RDSO/B-1623 v${t1.versionNo}`);
  const [rows] = await db.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details d ON d.master_id = m.id
      WHERE m.company_id = ? AND d.owner_order_line_id = ? AND m.deleted_at IS NULL`, [COMPANY, t1.lineId]);
  const byName = (n) => rows.filter((r) => r.name === n).map((r) => Number(r.id));
  const idOf = async (table, code) => { const r = await one(`SELECT id FROM ${table} WHERE company_id = ? AND code = ? AND deleted_at IS NULL`, [COMPANY, code]); if (!r) throw new Error(`${code} missing`); return Number(r.id); };
  // sections
  const bars = { 'Channel shear connector': 'CHAN-250X80X7.2X12000-E250BO', 'X-frame top angle': 'ISA-75X75X8X10000-E250BO', 'X-frame bottom angle': 'ISA-75X75X8X10000-E250BO', 'X-frame diagonal angle': 'ISA-75X75X8X10000-E250BO', 'Lifting beam channel': 'CHAN-350X100X8.1X12000-E250BO' };
  for (const [name, code] of Object.entries(bars)) {
    const bar = await idOf('cf_master_records', code);
    for (const id of byName(name)) await updateRecord(db, c, id, { cutStockId: bar });
  }
  await withCutPieces(db, c, t1.lineId, {});
  // flows (the rows' own flows)
  const flows = { 'Lifting beam': 'BRACING', 'Bearing assembly': 'SPLICE-SET', 'Channel shear connector': 'PLAIN-PART', 'Bearing flat': 'PLAIN-PART', 'Lifting beam channel': 'PLAIN-PART',
    'Bed plate': 'PLAIN-PART', 'Sliding plate': 'PLAIN-PART', 'Location strip': 'PLAIN-PART', 'Phosphor bronze plate': 'PLAIN-PART' };
  const changes = [];
  for (const [name, code] of Object.entries(flows)) { const f = await idOf('cf_operation_flows', code); for (const id of byName(name)) changes.push({ op: 'ownFlow', recordId: id, flowId: f }); }
  const bc = await applyBomChanges(db, c, { scope: { orderLineId: t1.lineId }, changes }, { allow: () => {} });
  console.log(`  flows: ${bc.summary?.sentence ?? changes.length}`);
  // values
  const one1 = (n) => { const ids = byName(n); if (ids.length !== 1) throw new Error(`${n}: ${ids.length} rows`); return ids[0]; };
  const writes = [
    [one1('Composite girder span'), 'SPAN_LENGTH', '9150'], [one1('Girder line'), 'LINEMATCH_JOINTS', '2'],
    ...['COATS:2', 'METALLISE_COATS:1', 'MIG_WELD_LENGTH:6', 'MIG_WELD_SIZE:6', 'PAINT_COATS:3'].map((x) => [one1('Intermediate diaphragm frame'), ...x.split(':')]),
    [one1('Phosphor bronze plate'), 'GRADE', 'E250'], [one1('Phosphor bronze plate'), 'IMPACT_CLASS', 'BR'],
    ...['COATS:2', 'METALLISE_COATS:1', 'MIG_WELD_SIZE:6', 'MIG_WELD_LENGTH:4', 'PAINT_COATS:3', 'SURFACE_AREA:3.4'].map((x) => [one1('Lifting beam'), ...x.split(':')]),
  ].map(([recordId, specCode, value]) => ({ recordId, specCode, value }));
  await writeLineValues(db, c, t1.lineId, { writes });
  await saveExecutionPlan(db, c, t1.orderId, { production: { level: 'line', levelId: null }, dispatch: { level: 'same', levelId: null } });
  const check1 = await lockPlan(db, COMPANY, t1.lineId);
  const bad1 = check1.checks.filter((k) => k.applies && !k.ok);
  if (bad1.length) throw new Error(`fixed line still cannot freeze: ${bad1.map((k) => `${k.key}: ${k.detail}`).join(' | ')}`);
  const saved = await saveLineToStandard(db, c, t1.lineId, { note: 'Fixes from the placebo_sandbox dry run 2026-10-30: section bars on 5 section parts, flows on 14 rows, values freeze asks for (span 9150)' });
  console.log(`  standard saved as v${saved.saved.versionNo} (${saved.saved.rows} rows, ${saved.saved.weightKg} kg)`);
  await deleteOrder(db, c, t1.orderId);
  // proof: a fresh line from the new version freezes as it comes
  const t2 = await throwaway('B');
  await saveExecutionPlan(db, c, t2.orderId, { production: { level: 'line', levelId: null }, dispatch: { level: 'same', levelId: null } });
  const check2 = await lockPlan(db, COMPANY, t2.lineId);
  const bad2 = check2.checks.filter((k) => k.applies && !k.ok);
  console.log(`  fresh line from v${t2.versionNo}: ${bad2.length ? 'NOT freeze-ready — ' + bad2.map((k) => k.key).join(', ') : `freeze-ready, ${check2.summary?.codes ?? '?'} codes, ${check2.summary?.duplicates ?? 0} duplicates`}`);
  await deleteOrder(db, c, t2.orderId);
  if (bad2.length) throw new Error('the new version is not freeze-ready — nothing applied');

  if (APPLY) { await db.commit(); console.log('COMMITTED'); } else { await db.rollback(); console.log('Dry run — rolled back. Add --apply.'); }
} catch (e) {
  await db.rollback();
  console.error('ROLLED BACK:', e.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
