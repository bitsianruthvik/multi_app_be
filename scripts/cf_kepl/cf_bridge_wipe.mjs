/**
 * cf_bridge_wipe.mjs — removes the FIRST attempt at the bridge so the corrected
 * model can be built in its place.
 *
 * What goes: the sales order and its temporaries, the two templates and the
 * segment selection, and every catalog item I filed under Fabricated — the 29
 * plate parts, 5 girder segment designs, 2 diaphragms and the splice set. Those
 * were catalog items; under the corrected model they are template definitions,
 * and their instances are the order's temporary items.
 *
 * What STAYS: the classification tree, all 17 specifications, the 3 formulas,
 * the 10 coding rules, the 1,414 raw materials, the shear stud, and the
 * customer. None of that was wrong.
 *
 * Order matters — a definition cannot be deleted while temporaries exist from
 * it, and an item cannot be deleted while a BOM names it. So: order first,
 * then definitions, then assemblies, then the parts they held.
 *
 *   cd multi_app_be && node scripts/cf_kepl/cf_bridge_wipe.mjs [--dry-run]
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const recs = await imp('apps/cf_erp/services/masterRecordService.js');
const orders = await imp('apps/cf_erp/services/salesOrderService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');

const DRY = process.argv.includes('--dry-run');
const COMPANY = Number(process.env.CF_BRIDGE_COMPANY ?? 2);
const c = { companyId: COMPANY, userId: Number(process.env.CF_BRIDGE_USER ?? 22) };
const say = (...a) => console.log(...a);

/** Everything filed under these nodes was built as a catalog item and should not have been. */
const WRONG_NODES = ['PLATE_PART', 'PROFILE_PART', 'GIRDER_SEGMENT', 'DIAPHRAGM', 'SPLICE_SET', 'GIRDER_LINE', 'BRIDGE_SPAN'];

const conn = await pool.getConnection();
const tally = { orders: 0, definitions: 0, items: 0, refused: [] };

async function drop(label, id, code) {
  if (DRY) { say(`   would delete  ${label.padEnd(12)} ${code}`); return true; }
  try { await recs.deleteRecord(conn, c, id); say(`   deleted  ${label.padEnd(12)} ${code}`); return true; }
  catch (e) { tally.refused.push(`${code}: ${e.code} ${e.message}`); say(`   REFUSED  ${label.padEnd(12)} ${code}  ${e.code} — ${e.message}`); return false; }
}

try {
  await conn.beginTransaction();
  attachNodeCache(conn);

  // --- 1. the order, which takes its temporary tree with it -----------------
  const [ords] = await conn.query(
    'SELECT id, code, status FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  say(`\n-- sales orders (${ords.length}) --`);
  for (const o of ords) {
    if (DRY) { say(`   would delete  order ${o.code} [${o.status}]`); tally.orders++; continue; }
    try { await orders.deleteOrder(conn, c, o.id); say(`   deleted  order ${o.code}`); tally.orders++; }
    catch (e) { tally.refused.push(`${o.code}: ${e.code} ${e.message}`); say(`   REFUSED  order ${o.code}  ${e.code} — ${e.message}`); }
  }

  // --- 2 & 3. definitions and the wrongly-filed items ----------------------
  // Deletion order is a dependency order and it is not obvious: a selection is
  // held by the template whose BOM names it, the segments are held by that
  // selection's allowed list, and the parts are held by the segments' BOMs. So
  // rather than hand-sort it, keep sweeping until a pass frees nothing — what
  // is still refused on the last pass is genuinely stuck, not just out of turn.
  const targets = async () => {
    const [defs] = await conn.query(
      `SELECT m.id, m.code, m.name, d.definition_type AS label FROM cf_master_records m
         JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
        WHERE m.company_id = ? AND m.deleted_at IS NULL`, [COMPANY]);
    const [items] = await conn.query(
      `SELECT m.id, m.code, m.name, n.code AS label FROM cf_master_records m
         JOIN cf_classification_nodes n ON n.id = m.classification_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND n.code IN (?)`,
      [COMPANY, WRONG_NODES]);
    return [...defs, ...items];
  };

  let pass = 0;
  let stuck = [];
  for (;;) {
    pass += 1;
    const left = await targets();
    if (!left.length) { say(`
-- pass ${pass}: nothing left --`); break; }
    say(`
-- pass ${pass}: ${left.length} to remove --`);
    let freed = 0;
    stuck = [];
    for (const r of left) {
      const code = r.code ?? r.name;
      if (DRY) { say(`   would delete  ${String(r.label).padEnd(14)} ${code}`); freed++; continue; }
      try {
        await recs.deleteRecord(conn, c, r.id);
        say(`   deleted  ${String(r.label).padEnd(14)} ${code}`);
        freed++;
      } catch (e) { stuck.push(`${code}: ${e.code} — ${e.message}`); }
    }
    if (DRY) break;
    if (!freed) { say(`   ${stuck.length} could not be freed on this pass — stopping`); break; }
  }
  tally.refused = stuck;

  if (DRY) { await conn.rollback(); say('\n(dry run — nothing was written)'); }
  else { await conn.commit(); }

  // --- what survived --------------------------------------------------------
  const [[left]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL) AS nodes,
            (SELECT COUNT(*) FROM cf_specifications WHERE company_id = ? AND deleted_at IS NULL) AS specs,
            (SELECT COUNT(*) FROM cf_formulas WHERE company_id = ? AND deleted_at IS NULL) AS formulas,
            (SELECT COUNT(*) FROM cf_code_schemes WHERE company_id = ? AND deleted_at IS NULL) AS coding_rules,
            (SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND record_kind = 'item') AS items,
            (SELECT COUNT(*) FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND record_kind = 'definition') AS definitions,
            (SELECT COUNT(*) FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL) AS parties`,
    Array(7).fill(COMPANY));
  say(`\nremoved: ${tally.orders} order(s), ${tally.definitions} definition(s), ${tally.items} item(s)`);
  if (tally.refused.length) { say(`\n${tally.refused.length} REFUSED:`); for (const r of tally.refused) say('   ' + r); }
  say(`\nstill there: ${left.nodes} classification nodes · ${left.specs} specs · ${left.formulas} formulas`
    + ` · ${left.coding_rules} coding rules · ${left.items} items · ${left.definitions} definitions · ${left.parties} parties`);
} catch (e) { await conn.rollback(); console.error('\nFAILED:', e.code, e.message, e.problems ?? ''); process.exitCode = 1; }
finally { detachNodeCache(conn); conn.release(); await pool.end(); }
