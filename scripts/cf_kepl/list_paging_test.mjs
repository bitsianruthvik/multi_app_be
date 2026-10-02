/**
 * list_paging_test.mjs — lists filter, count and page on the SERVER, so nothing
 * past the old 200 / 500 caps is lost (2026-10-02: "the catalog says only 500
 * items are there … whenever I filter anything, not sure if everything is
 * visible"). Contract: apps/cf_erp/lib/listing.js.
 *
 *   cd multi_app_be && node scripts/cf_kepl/list_paging_test.mjs
 *   CF_LP_COMPANY=2 (default)
 *
 * Everything runs inside ONE transaction that is rolled back; the table counts
 * are compared before and after.
 *   1. parties: 620 fixture rows (> the old 500 cap) — paged search reaches all,
 *      pages do not overlap, role + status counts match SQL, all=1 = every match,
 *      the old caller still gets the old bare array (200 default)
 *   2. parties: the paged answer is 2 queries (rows + counts), not per row
 *   3. orders: 540 fixture orders incl. revisions — chips filter on the server,
 *      counts are over every order (latest revision once), an earlier revision is
 *      filed under its replacement's status, sort by code desc pages stably
 *   4. lib/listing.js helpers
 */
import '../../apps/cf_erp/services/codegenProvider.js';
import { pool } from '../../db.js';
import { listParties } from '../../apps/cf_erp/modules/parties/service.js';
import { listOrders } from '../../apps/cf_erp/services/salesOrderService.js';
import { pageArgs, orderBy, likeOf, pageOf, countsBy, EXPORT_MAX } from '../../apps/cf_erp/lib/listing.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_LP_COMPANY ?? 2);
const TAG = `LPT${process.pid}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else failed++;
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const TABLES = ['cf_parties', 'cf_sales_orders'];
const tableCounts = async (db) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => {
  const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${t}`);
  return [t, Number(n)];
})));

/** Reads every page of a paged list until hasMore is false. */
async function readAll(fn, q, limit) {
  const rows = [];
  for (let offset = 0, guard = 0; guard < 100; guard++) {
    const p = await fn({ ...q, paged: 1, limit, offset });
    rows.push(...p.rows);
    if (!p.hasMore) return { rows, last: p };
    offset += p.rows.length;
  }
  throw new Error('paging did not end');
}

const before = await tableCounts(pool);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  section('1. parties: 620 rows past the old cap');
  const N = 620;
  const parties = [];
  for (let i = 0; i < N; i++) {
    const customer = i % 3 !== 2 ? 1 : 0;         // 414 customers
    const supplier = i % 2 === 0 ? 1 : 0;         // 310 suppliers
    const status = i % 10 === 0 ? 'inactive' : 'active';
    const email = i % 4 === 0 ? null : `${TAG.toLowerCase()}${i}@x.test`;
    parties.push([COMPANY, `${TAG}-${String(i).padStart(4, '0')}`, `${TAG} party ${i}`, customer, supplier, 0, status, email]);
  }
  await conn.query('INSERT INTO cf_parties (company_id, code, name, is_customer, is_supplier, is_subcontractor, status, email) VALUES ?', [parties]);
  const [[truth]] = await conn.query(
    `SELECT COUNT(*) AS n, SUM(is_customer) AS c, SUM(is_supplier) AS s,
            SUM(is_customer = 1 AND status = 'active') AS ca, SUM(is_customer = 1 AND status <> 'active') AS ci,
            SUM(is_customer = 1 AND (email IS NULL OR email = '') AND (phone IS NULL OR phone = '')) AS cn
       FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND code LIKE ?`,
    [COMPANY, `${TAG}-%`],
  );
  const P = (q) => listParties(conn, COMPANY, q);
  const first = await P({ paged: 1, search: TAG, limit: 500 });
  eq('total counts all 620 matches, not the 500 loaded', first.total, N);
  eq('first page holds 500', first.rows.length, 500);
  ok('hasMore says there is more', first.hasMore === true);
  const { rows: everyParty, last } = await readAll(P, { search: TAG }, 500);
  eq('paging reaches every match', everyParty.length, N);
  eq('pages do not overlap', new Set(everyParty.map((p) => p.id)).size, N);
  ok('the last page has hasMore false', last.hasMore === false);
  const cust = await P({ paged: 1, search: TAG, role: 'customer', limit: 50 });
  eq('role=customer total = every customer', cust.total, Number(truth.c));
  eq('role chip counts are over every role (customer)', cust.counts.roles.customer, Number(truth.c));
  eq('role chip counts are over every role (supplier)', cust.counts.roles.supplier, Number(truth.s));
  eq('role chip counts: all', cust.counts.roles.all, N);
  eq('active figure (role + search)', cust.counts.active, Number(truth.ca));
  eq('inactive figure', cust.counts.inactive, Number(truth.ci));
  eq('no-contact figure', cust.counts.noContact, Number(truth.cn));
  ok('every customer row is a customer', cust.rows.every((p) => p.roles.includes('customer')));
  const deep = await P({ paged: 1, search: `${TAG}-0611`, limit: 10 });
  eq('a search finds a row far past the old cap', deep.rows.map((p) => p.code), [`${TAG}-0611`]);
  const all = await P({ all: 1, search: TAG });
  eq('all=1 (export) returns every match', all.rows.length, N);
  ok('all=1 is not truncated', all.truncated === undefined);
  const sorted = await readAll(P, { search: TAG, sort: 'code', dir: 'desc' }, 250);
  const codes = sorted.rows.map((p) => p.code);
  eq('sort=code desc pages in order', codes.join(), [...codes].sort().reverse().join());
  const old = await P({ search: TAG });
  ok('an old caller (no paged) still gets a bare array', Array.isArray(old));
  eq('… with the old 200 default', old.length, 200);
  const named = await P({ paged: 1, ids: `${everyParty[3].id},${everyParty[600].id}` });
  eq('ids= reads the named parties', named.rows.map((p) => p.id).sort((a, b) => a - b), [everyParty[3].id, everyParty[600].id].sort((a, b) => a - b));

  section('2. parties: round trips');
  let queries = 0;
  const counting = { query: (...a) => { queries++; return conn.query(...a); } };
  await listParties(counting, COMPANY, { paged: 1, search: TAG, role: 'supplier', limit: 100 });
  eq('a paged answer is 2 queries (rows + counts)', queries, 2);

  section('3. orders: 540 rows with revisions');
  const [[cust1]] = await conn.query('SELECT id FROM cf_parties WHERE company_id = ? AND code = ?', [COMPANY, `${TAG}-0001`]);
  const STATUSES = ['inquiry', 'quoted', 'confirmed', 'draft', 'closed', 'lost', 'cancelled'];
  const orders = [];
  const past = '2020-01-01';
  for (let i = 0; i < 520; i++) {
    const status = STATUSES[i % STATUSES.length];
    orders.push([COMPANY, `${TAG}-SO-${String(i).padStart(4, '0')}`, i % 5 === 0 ? 'stock' : 'customer', `${TAG} order ${i}`, i % 5 === 0 ? null : cust1.id, status, i % 6 === 0 ? past : null, i < 20 ? 2 : 1, null]);
  }
  // 20 earlier revisions: rev 1 'revised' (was quoted), the order above is rev 2.
  for (let i = 0; i < 20; i++) {
    orders.push([COMPANY, `${TAG}-SO-${String(i).padStart(4, '0')}`, i % 5 === 0 ? 'stock' : 'customer', `${TAG} order ${i} r1`, i % 5 === 0 ? null : cust1.id, 'revised', null, 1, 'quoted']);
  }
  await conn.query(
    'INSERT INTO cf_sales_orders (company_id, code, order_type, title, customer_id, status, committed_date, revision, status_before_revised) VALUES ?',
    [orders],
  );
  const O = (q) => listOrders(conn, COMPANY, q);
  const [byStatus] = await conn.query(
    `SELECT status, COUNT(*) AS n, SUM(committed_date < CURDATE() AND status NOT IN ('closed','lost','cancelled','revised')) AS overdue
       FROM cf_sales_orders WHERE company_id = ? AND deleted_at IS NULL AND code LIKE ? AND status <> 'revised' GROUP BY status`,
    [COMPANY, `${TAG}-SO-%`],
  );
  const want = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
  const wantOpen = ['draft', 'inquiry', 'quoted', 'confirmed'].reduce((t, s) => t + (want[s] ?? 0), 0);
  const wantOverdue = byStatus.reduce((t, r) => t + Number(r.overdue || 0), 0);
  const o1 = await O({ paged: 1, search: `${TAG}-SO`, chip: 'open', limit: 100, sort: 'code', dir: 'desc' });
  eq('chip=open total = every open order', o1.total, wantOpen);
  eq('chips.open', o1.counts.chips.open, wantOpen);
  eq('chips.all = every latest order (520)', o1.counts.chips.all, 520);
  eq('chips.confirmed', o1.counts.chips.confirmed, want.confirmed);
  eq('chips.closed (a chip the open filter hides)', o1.counts.chips.closed, want.closed);
  eq('chips.overdue', o1.counts.chips.overdue, wantOverdue);
  const allOpen = await readAll(O, { search: `${TAG}-SO`, chip: 'open', sort: 'code', dir: 'desc' }, 100);
  eq('paging reaches every open order', allOpen.rows.length, wantOpen);
  ok('every row is open', allOpen.rows.every((o) => ['draft', 'inquiry', 'quoted', 'confirmed'].includes(o.status)));
  const oc = allOpen.rows.map((o) => o.code);
  eq('code desc is in order across pages', oc.join(), [...oc].sort().reverse().join());
  const overdue = await O({ paged: 1, search: `${TAG}-SO`, chip: 'overdue', limit: 500 });
  eq('chip=overdue total', overdue.total, wantOverdue);
  ok('every overdue row is overdue', overdue.rows.every((o) => o.overdue));
  const withRev = await O({ paged: 1, search: `${TAG}-SO`, chip: 'confirmed', revisions: 'all', limit: 500 });
  const confRevised = withRev.rows.filter((o) => o.status === 'revised');
  // codes 0..19 at rev 2: i % 7 === 2 → confirmed → i = 2, 9, 16
  eq('an earlier revision is filed under its replacement (confirmed)', confRevised.map((o) => o.code).sort(), [2, 9, 16].map((i) => `${TAG}-SO-${String(i).padStart(4, '0')}`));
  eq('… and the chip counts still count each order once', withRev.counts.chips.confirmed, want.confirmed);
  const stock = await O({ paged: 1, search: `${TAG}-SO`, orderType: 'stock', chip: 'all', limit: 10 });
  eq('orderType=stock total', stock.total, 104);
  eq('chips follow the type filter', stock.counts.chips.all, 104);
  const oldOrders = await O({ search: `${TAG}-SO` });
  ok('old caller (no paged) still gets a bare array', Array.isArray(oldOrders));
  eq('… with the old 200 default', oldOrders.length, 200);
  const deepOrder = await O({ paged: 1, search: `${TAG}-SO-0519`, chip: 'all' });
  eq('a search reaches an order past the old 500 cap', deepOrder.rows.map((o) => o.code), [`${TAG}-SO-0519`]);
  const every = await O({ all: 1, search: `${TAG}-SO`, chip: 'all' });
  eq('all=1 returns every order', every.rows.length, 520);

  section('4. lib/listing.js');
  eq('pageArgs default', pageArgs({}), { limit: 100, offset: 0, all: false });
  eq('pageArgs caps at 500', pageArgs({ limit: 9999, offset: '20' }).limit, 500);
  eq('pageArgs all', pageArgs({ all: '1' }), { limit: EXPORT_MAX, offset: 0, all: true });
  eq('orderBy whitelist', orderBy({ sort: 'x', dir: 'desc' }, { x: 'a.b' }, 'id', 'a.id'), '(a.b) IS NULL, a.b DESC, a.id');
  eq('orderBy unknown key → fallback', orderBy({ sort: 'drop table' }, { x: 'a.b' }, 'id'), 'id');
  eq('likeOf escapes', likeOf(' 5%_a '), '%5\\%\\_a%');
  eq('likeOf blank', likeOf('  '), null);
  eq('pageOf hasMore', pageOf([1, 2], 5, { limit: 2, offset: 0, all: false }).hasMore, true);
  eq('countsBy', countsBy([{ k: 'a', n: '2' }, { k: null, n: 1 }], ['a', 'b']), { a: 2, b: 0 });
} finally {
  await conn.rollback();
  conn.release();
}
const after = await tableCounts(pool);
section('table counts restored');
eq('cf_parties / cf_sales_orders unchanged', after, before);
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
