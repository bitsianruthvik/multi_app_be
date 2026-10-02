/**
 * records_kinds_test.mjs — the Items / Definitions kind chips are answered by
 * the server (masterRecordService.listRecords), not filtered over a 500-row page.
 *
 *   cd multi_app_be && node scripts/cf_kepl/records_kinds_test.mjs
 *   CF_RK_COMPANY=2 (the default: the local KEPL copy)
 *
 * Read-only: it compares listRecords against plain COUNTs of the same rows.
 *   1. kinds=catalog,temporary returns both kinds; the default still hides temporary
 *   2. kind=temporary returns only temporary items, and its total is all of them
 *   3. kindCounts counts every kind whatever the kind filter, in the same 2 queries
 *   4. definitions: kind=template / selection; kindCounts agree
 */
import '../../apps/cf_erp/services/codegenProvider.js';
import { pool } from '../../db.js';
import { listRecords } from '../../apps/cf_erp/services/masterRecordService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_RK_COMPANY ?? 2);

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else failed++;
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

try {
  const [truth] = await pool.query(
    `SELECT COALESCE(i.item_type, d.definition_type) AS kind, COUNT(*) AS n
       FROM cf_master_records m
       JOIN cf_classification_nodes c ON c.id = m.classification_id
       LEFT JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       LEFT JOIN cf_definition_details d ON d.master_id = m.id AND d.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL
      GROUP BY COALESCE(i.item_type, d.definition_type)`,
    [COMPANY],
  );
  const real = Object.fromEntries(truth.map((r) => [r.kind, Number(r.n)]));
  const want = { catalog: real.catalog ?? 0, temporary: real.temporary ?? 0, template: real.template ?? 0, selection: real.selection ?? 0 };
  console.log(`company ${COMPANY}: ${JSON.stringify(want)}`);
  ok('the local copy has temporary items to find', want.temporary > 0);

  section('1. kinds=catalog,temporary returns both; the default hides temporary');
  const both = await listRecords(pool, COMPANY, { recordKind: 'item', kinds: 'catalog,temporary', limit: 500 });
  eq('total = catalog + temporary', both.total, want.catalog + want.temporary);
  const temps = await listRecords(pool, COMPANY, { recordKind: 'item', kinds: 'catalog,temporary', search: '', limit: 500, offset: Math.max(0, want.catalog + want.temporary - 500) });
  ok('a temporary item is among the rows (both kinds come back)', both.rows.concat(temps.rows).some((r) => r.kind === 'temporary'));
  const dflt = await listRecords(pool, COMPANY, { recordKind: 'item', limit: 5 });
  eq('the default list still hides temporary items (total = catalog)', dflt.total, want.catalog);

  section('2. kind=temporary');
  const onlyTemp = await listRecords(pool, COMPANY, { recordKind: 'item', kind: 'temporary', limit: 500 });
  eq('total = every temporary item', onlyTemp.total, want.temporary);
  ok('rows are all temporary', onlyTemp.rows.every((r) => r.kind === 'temporary'));
  const onlyCat = await listRecords(pool, COMPANY, { recordKind: 'item', kind: 'catalog', limit: 500 });
  eq('kind=catalog total = every catalog item', onlyCat.total, want.catalog);

  section('3. kindCounts: every kind, whatever the filter, in 2 queries');
  eq('kindCounts with kind=temporary', [onlyTemp.kindCounts.catalog, onlyTemp.kindCounts.temporary], [want.catalog, want.temporary]);
  eq('kindCounts with the default filter (temporary counted though hidden)', [dflt.kindCounts.catalog, dflt.kindCounts.temporary], [want.catalog, want.temporary]);
  let queries = 0;
  const conn = await pool.getConnection();
  const real2 = conn.query.bind(conn);
  conn.query = (...a) => { queries++; return real2(...a); };
  await listRecords(conn, COMPANY, { recordKind: 'item', kind: 'temporary', limit: 50 });
  conn.query = real2;
  conn.release();
  eq('rows + counts = 2 queries', queries, 2);

  section('4. definitions');
  const tpl = await listRecords(pool, COMPANY, { recordKind: 'definition', kind: 'template', limit: 500 });
  eq('kind=template total', tpl.total, want.template);
  eq('definition kindCounts', [tpl.kindCounts.template, tpl.kindCounts.selection], [want.template, want.selection]);
  const sel = await listRecords(pool, COMPANY, { recordKind: 'definition', kind: 'selection', limit: 500 });
  ok('kind=selection rows are all selections', sel.rows.every((r) => r.kind === 'selection') && sel.total === want.selection);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
