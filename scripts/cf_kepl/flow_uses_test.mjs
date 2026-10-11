/**
 * flow_uses_test.mjs — a flow's "Made by it" is the CATALOG only (user, 2026-10-11): items and
 * definitions of THIS company that name THIS flow; order rows (temporary items) are counted, never
 * listed. Read-only: nothing is written.
 *   node scripts/cf_kepl/flow_uses_test.mjs
 */
const COMPANY = Number(process.env.CF_COMPANY || 2);
const { pool } = await import('../../db.js');
const { getFlow } = await import('../../apps/cf_erp/services/flowService.js');
let passed = 0; let failed = 0;
const ok = (name, cond, detail = '') => { if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name} ${detail}`); } };
try {
  const [flows] = await pool.query(
    `SELECT f.id, f.code,
            (SELECT COUNT(*) FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = f.company_id AND m.default_flow_id = f.id AND m.deleted_at IS NULL AND i.item_type = 'temporary') AS order_rows,
            (SELECT COUNT(*) FROM cf_master_records m LEFT JOIN cf_item_details i ON i.master_id = m.id WHERE m.company_id = f.company_id AND m.default_flow_id = f.id AND m.deleted_at IS NULL AND COALESCE(i.item_type, '') <> 'temporary') AS catalog
       FROM cf_operation_flows f WHERE f.company_id = ? AND f.deleted_at IS NULL ORDER BY order_rows DESC, catalog DESC LIMIT 6`, [COMPANY]);
  ok('the tenant has flows to look at', flows.length > 0);
  let sawRows = false;
  for (const f of flows) {
    const d = await getFlow(pool, COMPANY, f.id);
    const ids = d.uses.records.map((r) => r.id);
    const [mine] = ids.length ? await pool.query('SELECT id, company_id, default_flow_id FROM cf_master_records WHERE id IN (?)', [ids]) : [[]];
    ok(`${f.code}: every listed record is this company's and names this flow (${ids.length})`, mine.every((m) => Number(m.company_id) === COMPANY && Number(m.default_flow_id) === Number(f.id)), JSON.stringify(mine.slice(0, 3)));
    ok(`${f.code}: no order row is listed`, d.uses.records.every((r) => r.kind !== 'temporary'), [...new Set(d.uses.records.map((r) => r.kind))].join(','));
    ok(`${f.code}: the counts are the catalog (${f.catalog}) and the order rows (${f.order_rows})`, d.uses.recordCount === Number(f.catalog) && d.uses.orderRows === Number(f.order_rows), `${d.uses.recordCount} / ${d.uses.orderRows}`);
    ok(`${f.code}: the list is the catalog count, up to 100`, ids.length === Math.min(100, Number(f.catalog)), String(ids.length));
    if (Number(f.order_rows) > 0) sawRows = true;
  }
  ok('at least one flow here makes order rows, so the exclusion was really exercised', sawRows);
} catch (e) { failed += 1; console.error('ERROR', e.message); }
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
