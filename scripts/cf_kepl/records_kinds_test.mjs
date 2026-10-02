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
 *   5. paged=1 over 620 fixture rows (rolled back; table counts restored): classification subtree +
 *      status + kind + search filters give the right total and counts.kind / counts.status /
 *      counts.noCode / counts.overall past 500 rows; pages do not overlap; all=1 = every match;
 *      sort by name desc; the paged answer is a handful of queries, never per row
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
  section('5. paged=1: 620 fixture rows, filters and counts over every match');
  const TAG = `RKT${process.pid}`;
  const TABLES = ['cf_master_records', 'cf_item_details', 'cf_definition_details'];
  const tableCounts = async (db) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => { const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${t}`); return [t, Number(n)]; })));
  const before = await tableCounts(pool);
  const fx = await pool.getConnection();
  try {
    await fx.beginTransaction();
    // A family with two children (the subtree) and a branch outside it.
    const [[tpl]] = await fx.query('SELECT * FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND depth = 1 LIMIT 1', [COMPANY]);
    const mkNode = async (parentId, depth, code) => {
      const [r] = await fx.query(
        'INSERT INTO cf_classification_nodes (company_id, parent_id, depth, code, name, scope) SELECT company_id, ?, ?, ?, ?, scope FROM cf_classification_nodes WHERE id = ?',
        [parentId, depth, `${TAG}${code}`, `${TAG} ${code}`, tpl.id],
      );
      return r.insertId;
    };
    const fam = await mkNode(tpl.parent_id, tpl.depth, 'F');
    const subA = await mkNode(fam, tpl.depth + 1, 'A');
    const subB = await mkNode(fam, tpl.depth + 1, 'B');
    const other = await mkNode(tpl.parent_id, tpl.depth, 'O');
    const N = 620;
    const plan = [];
    for (let i = 0; i < N; i++) {
      plan.push({
        i,
        node: i % 7 === 0 ? other : (i % 2 ? subA : subB),
        kind: i % 4 === 3 ? 'temporary' : 'catalog',
        status: i % 5 === 0 ? 'draft' : i % 11 === 0 ? 'obsolete' : 'active',
        code: i % 25 === 0 ? null : `${TAG}-${String(i).padStart(4, '0')}`,
      });
    }
    await fx.query(
      'INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES ?',
      [plan.map((r) => [COMPANY, 'item', r.code, `${TAG} fixture ${String(r.i).padStart(4, '0')}`, r.node, r.status])],
    );
    const [ids] = await fx.query('SELECT id, name FROM cf_master_records WHERE company_id = ? AND name LIKE ? ORDER BY name', [COMPANY, `${TAG} fixture %`]);
    await fx.query('INSERT INTO cf_item_details (master_id, company_id, item_type) VALUES ?', [ids.map((r, k) => [r.id, COMPANY, plan[k].kind])]);
    eq('620 fixture rows exist', ids.length, N);

    const L = (q) => listRecords(fx, COMPANY, { recordKind: 'item', paged: 1, search: TAG, ...q });
    const inSub = (r) => r.node !== other;
    const tally = (rows, f) => rows.filter(f).length;
    const everything = await L({ kinds: 'catalog,temporary', limit: 100 });
    eq('total = 620 (past the old 500 cap)', everything.total, N);
    eq('first page is 100 rows and hasMore', [everything.rows.length, everything.hasMore], [100, true]);
    eq('counts.status over everything', [everything.counts.status.draft, everything.counts.status.active, everything.counts.status.obsolete, everything.counts.status.all],
      [tally(plan, (r) => r.status === 'draft'), tally(plan, (r) => r.status === 'active'), tally(plan, (r) => r.status === 'obsolete'), N]);
    eq('counts.kind over everything', [everything.counts.kind.catalog, everything.counts.kind.temporary], [tally(plan, (r) => r.kind === 'catalog'), tally(plan, (r) => r.kind === 'temporary')]);
    eq('counts.noCode', everything.counts.noCode, tally(plan, (r) => !r.code));
    ok('counts.overall is every item on the screen (>= 620)', everything.counts.overall >= N);

    // classification subtree + status + kind together
    const f = (r) => inSub(r) && r.kind === 'catalog' && r.status === 'active';
    const res = await L({ kind: 'catalog', status: 'active', classificationId: fam, limit: 500 });
    eq('subtree + status + kind: total', res.total, tally(plan, f));
    ok('rows are all in the subtree, catalog, active', res.rows.length > 0 && res.rows.every((r) => [subA, subB].includes(r.classificationId) && r.kind === 'catalog' && r.status === 'active'));
    eq('counts.kind is over status + classification (the kind chip itself ignored)',
      [res.counts.kind.catalog, res.counts.kind.temporary],
      [tally(plan, (r) => inSub(r) && r.status === 'active' && r.kind === 'catalog'), tally(plan, (r) => inSub(r) && r.status === 'active' && r.kind === 'temporary')]);
    eq('counts.status is over kind + classification (the status chip itself ignored)',
      [res.counts.status.draft, res.counts.status.active, res.counts.status.obsolete, res.counts.status.all],
      [tally(plan, (r) => inSub(r) && r.kind === 'catalog' && r.status === 'draft'), tally(plan, (r) => inSub(r) && r.kind === 'catalog' && r.status === 'active'),
        tally(plan, (r) => inSub(r) && r.kind === 'catalog' && r.status === 'obsolete'), tally(plan, (r) => inSub(r) && r.kind === 'catalog')]);
    eq('counts.total = total', res.counts.total, res.total);
    eq('counts.noCode is within all current filters', res.counts.noCode, tally(plan, (r) => f(r) && !r.code));
    const leaf = await L({ classificationId: subA, kinds: 'catalog,temporary' });
    eq('a leaf classification: total', leaf.total, tally(plan, (r) => r.node === subA));

    // paging: no overlap, every row reachable, sorted on the server
    const seen = [];
    for (let offset = 0, g = 0; g < 20; g++) {
      const pg = await L({ kinds: 'catalog,temporary', limit: 250, offset, sort: 'name', dir: 'desc' });
      seen.push(...pg.rows.map((r) => r.id));
      if (!pg.hasMore) break;
      offset += pg.rows.length;
    }
    eq('every page read: 620 distinct rows', [seen.length, new Set(seen).size], [N, N]);
    const first = await L({ kinds: 'catalog,temporary', limit: 3, sort: 'name', dir: 'desc' });
    eq('sort=name desc puts the highest name first', first.rows[0].name, `${TAG} fixture 0619`);
    const exp = await L({ kinds: 'catalog,temporary', all: 1 });
    eq('all=1 returns every match', [exp.rows.length, exp.hasMore], [N, false]);
    const one = await L({ kinds: 'catalog,temporary', search: `${TAG}-0619` });
    eq('search finds a row past the first 500', [one.total, one.rows[0]?.code], [1, `${TAG}-0619`]);

    // set-based: the subtree lookup, rows, the kind x status matrix and the overall figure — never per row
    let n = 0;
    const real = fx.query.bind(fx);
    fx.query = (...a) => { n++; return real(...a); };
    await L({ kind: 'catalog', status: 'active', classificationId: fam, limit: 100 });
    fx.query = real;
    ok('a paged answer with every filter is at most 5 queries (not per row)', n <= 5, `${n} queries`);
  } finally {
    await fx.rollback();
    fx.release();
  }
  eq('the table counts are restored', await tableCounts(pool), before);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
