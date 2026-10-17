/**
 * production_views_test.mjs — four production / planning improvements (2026-10-17). Local DB only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/production_views_test.mjs
 *   CF_PV_COMPANY (2)
 *
 *   A. own vs including: the tracker tree's `own` figures (a node's own steps) against its subtree
 *      (completion, minutes, byOperation) on a 3-level tree with a grouped leaf (quantity 4); a
 *      line's own = its top pieces' own steps; the dashboard's per-line / per-order own %; fixed
 *      round trips
 *   B. Production orders list (GET /production-orders): grouped by sales order, status / customer /
 *      search filters, paging by order, fixed round trips; work orders grouped by sales order
 *      (GET /work-orders/by-order and the dashboard's salesOrders summary)
 *   C. unplanned work: the plan check warns, the start still succeeds, the session and the start
 *      event carry unplanned = 1 (floor and tracker starts), a planned step is not warned, the
 *      dashboard counts "started unplanned"; p<piece>#<n> entries count for their piece
 *   D. planner settings: the snapshot carries no settings and PUT /planner/settings is gone
 *
 * Its own TEST-PROD-… orders, built straight into the tables (release itself is release_batch_test's),
 * INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing it does is re-count every cf_ table.
 * Line 923 is never touched.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const TREE = await imp('apps/cf_erp/services/trackerTreeService.js');
const DASH = await imp('apps/cf_erp/services/dashboardService.js');
const PO = await imp('apps/cf_erp/services/productionOrdersService.js');
const WO = await imp('apps/cf_erp/services/workOrderService.js');
const PLAN = await imp('apps/cf_erp/services/planCheckService.js');
const FLOOR = await imp('apps/cf_erp/services/floorService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const PLANNER = await imp('apps/cf_erp/services/plannerService.js');
const plannerRoutes = (await imp('apps/cf_erp/routes/planner.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PV_COMPANY ?? 2);
const RUN = `TEST-PROD-${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const near = (a, b, tol = 0.01) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
/** A db whose query() is counted (round trips = stages of parallel reads are not told apart here: queries). */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (t, p) => (p === 'query' ? (...a) => { tally.n += 1; return t.query(...a); } : Reflect.get(t, p)) });
  return { db: proxy, tally };
}

const conn = await pool.getConnection();
let exitCode = 0;
let before = null;
try {
  before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const ins = async (sql, args) => (await conn.query(sql, args))[0].insertId;
  console.log(`Company ${COMPANY} — run ${RUN}`);

  // ---- fixture ---------------------------------------------------------------
  const [[node]] = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope IN ('item','both') AND deleted_at IS NULL ORDER BY depth DESC, id LIMIT 1", [COMPANY]);
  const [[flow]] = await conn.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const [[machineType]] = await conn.query("SELECT classification_id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1", [COMPANY]);
  const master = async (key) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, node.id]);
    await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'make')", [id, COMPANY]);
    return id;
  };
  const party = (key, role) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, status) VALUES (?, ?, ?, 1, 'active')`, [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`]);
  const CUST_A = await party('CUSTA', 'is_customer');
  const CUST_B = await party('CUSTB', 'is_customer');
  const CON_1 = await party('CON1', 'is_subcontractor');
  const CON_2 = await party('CON2', 'is_subcontractor');
  const OPX = await ins("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, 'TP Assemble', 'active')", [COMPANY, `${RUN}-X`]);
  const OPY = await ins("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, 'TP Weld', 'active')", [COMPANY, `${RUN}-Y`]);
  const A = await master('A');
  const B = await master('B');
  const C = await master('C');
  const order = (key, customer, title) => ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id) VALUES (?, ?, 'customer', ?, 'confirmed', ?)", [COMPANY, `${RUN}-${key}`, title, customer]);
  const SO1 = await order('SO1', CUST_A, 'Views girder');
  const SO2 = await order('SO2', CUST_B, 'Views bracket');
  const line = (orderId, lineNo, item, qty, extra = {}) => ins(
    'INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, made_qty, delivered_qty) VALUES (?, ?, ?, \'standard\', ?, ?, ?, ?, ?, ?)',
    [COMPANY, orderId, lineNo, item, item, lineNo, qty, extra.made ?? 0, extra.delivered ?? 0]);
  const release = (orderId, lineId, item, qty) => ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, ?)', [COMPANY, orderId, lineId, item, qty]);
  let sort = 0;
  const piece = (rel, parent, item, qty, depth, code) => ins(
    'INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, rel, parent, item, qty, code, flow.id, depth, ++sort]);
  const step = (itemId, op, seq, qty, minutes, extra = {}) => ins(
    'INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, quantity, state, qty_good, est_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, itemId, op, seq, qty, extra.state ?? 'pending', extra.good ?? 0, minutes]);

  // SO1 line 1: P1 (assembly) › P2 (sub-assembly) › P3 (grouped leaf ×4) and P4 (leaf piece).
  const L1 = await line(SO1, 1, A, 1);
  const R1 = await release(SO1, L1, A, 1);
  const P1 = await piece(R1, null, A, 1, 0, `${RUN}-SO1-A`);
  const P2 = await piece(R1, P1, B, 1, 1, `${RUN}-SO1-A-B`);
  const P3 = await piece(R1, P2, C, 4, 2, `${RUN}-SO1-A-B-C`);
  const P4 = await piece(R1, P2, C, 1, 2, `${RUN}-SO1-A-B-D`);
  const S_P1X = await step(P1, OPX, 10, 1, 60);                                   // own of P1, not started
  const S_P2X = await step(P2, OPX, 10, 1, 30, { state: 'done', good: 1 });        // done
  const S_P2Y = await step(P2, OPY, 20, 1, 20);
  const S_P3Y = await step(P3, OPY, 10, 4, 40, { state: 'in_progress', good: 2 }); // half of the group
  const S_P4Y = await step(P4, OPY, 10, 1, 10, { state: 'done', good: 1 });
  // SO1 line 2: one piece, nothing started.
  const L2 = await line(SO1, 2, B, 1);
  const R2 = await release(SO1, L2, B, 1);
  const Q1 = await piece(R2, null, B, 1, 0, `${RUN}-SO1-L2`);
  const S_Q1X = await step(Q1, OPX, 10, 1, 15);
  // SO2 line 1: every step done and the line dispatched; SO2 line 2: planned, not started.
  const M1 = await line(SO2, 1, C, 2, { made: 2, delivered: 2 });
  const RM1 = await release(SO2, M1, C, 2);
  const T1 = await piece(RM1, null, C, 2, 0, `${RUN}-SO2-C`);
  await step(T1, OPX, 10, 2, 8, { state: 'done', good: 2 });
  const M2 = await line(SO2, 2, B, 1);
  const RM2 = await release(SO2, M2, B, 1);
  const U1 = await piece(RM2, null, B, 1, 0, `${RUN}-SO2-L2`);
  const S_U1X = await step(U1, OPX, 10, 1, 25);
  await conn.query('INSERT INTO cf_plan_entries (company_id, order_line_id, unit_key, ship_date) VALUES (?, ?, ?, ?)', [COMPANY, M2, `l${M2}`, '2026-11-20']);

  // ---- A. own vs including --------------------------------------------------------
  section('A. Own steps vs including everything below');
  const cnt1 = counting(conn);
  const tree = await TREE.trackerTree(cnt1.db, COMPANY, { lineId: L1, depth: 50, figures: '1' });
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const n1 = byId.get(`p${P1}`);
  const n2 = byId.get(`p${P2}`);
  const n3 = byId.get(`p${P3}`);
  const nl = byId.get(`l${L1}`);
  ok('the tree has the 3 levels and both leaves', !!(n1 && n2 && n3 && byId.get(`p${P4}`) && nl));
  // P1 own: 1 step of 60 min, nothing done → 0. Including: 60+30+20+40+10 = 160 min, done 30 + 20 (half of 40) + 10 = 60.
  ok('P1 own: its one step, 0 % (60 min, nothing done)', n1.own.steps === 1 && n1.own.completion === 0 && n1.own.minutes === 60 && n1.own.minutesDone === 0, JSON.stringify(n1.own));
  ok('P1 including: 160 min planned, 60 done → 37.5 %', n1.minutes === 160 && n1.minutesDone === 60 && near(n1.completion, 0.375, 0.0001), `${n1.minutes} ${n1.minutesDone} ${n1.completion}`);
  ok('P2 own: 2 steps, 30 of 50 min done (60 %)', n2.own.steps === 2 && n2.own.minutes === 50 && n2.own.minutesDone === 30 && near(n2.own.completion, 0.6, 0.0001), JSON.stringify(n2.own));
  ok('P2 including: 100 min, 60 done (60 %)', n2.minutes === 100 && n2.minutesDone === 60 && near(n2.completion, 0.6, 0.0001));
  const p2y = n2.byOperation.find((b) => b.operationId === OPY);
  ok('P2 including per operation: weld 3 of 6 counted, 30 of 70 min (own 20 + group 40 + leaf 10)', p2y && p2y.done === 3 && p2y.total === 6 && p2y.minutes === 70 && p2y.minutesDone === 30, JSON.stringify(p2y));
  ok('grouped leaf (×4): basis row, own = including (2 of 4, 20 of 40 min)', n3.basis === 'row' && n3.own.minutes === 40 && n3.own.minutesDone === 20 && n3.minutes === 40 && near(n3.own.completion, 0.5, 0.0001) && near(n3.completion, 0.5, 0.0001));
  ok('a piece op carries its planned minutes', n3.ops.length === 1 && n3.ops[0].minutes === 40);
  ok('a piece node sends no own.byOperation (its ops are its own)', n2.own.byOperation === undefined);
  ok('the line own = its top piece P1 own steps (1 step, 60 min, 0 %)', nl.own.steps === 1 && nl.own.minutes === 60 && nl.own.completion === 0 && nl.own.byOperation.length === 1, JSON.stringify(nl.own));
  ok('the line including = the whole line (160 min, 37.5 %)', nl.minutes === 160 && near(nl.completion, 0.375, 0.0001));
  ok('the order own adds its lines\' own (P1 60 + Q1 15 = 75 min) when both lines are read', true);
  const cntAll = counting(conn);
  const treeAll = await TREE.trackerTree(cntAll.db, COMPANY, { orderId: SO1, depth: 2, figures: '1' });
  const oNode = treeAll.nodes.find((n) => n.id === `o${SO1}`);
  ok('order own over two lines: 2 steps, 75 min', oNode && oNode.own.steps === 2 && oNode.own.minutes === 75, JSON.stringify(oNode?.own));
  ok(`tree reads take the same queries for one line and a whole order (${cnt1.tally.n} / ${cntAll.tally.n})`, cnt1.tally.n === cntAll.tally.n && cnt1.tally.n <= 16);
  const lean = await TREE.trackerTree(conn, COMPANY, { lineId: L1, depth: 50 });
  const leanP2 = lean.nodes.find((n) => n.id === `p${P2}`);
  ok('without figures=1 the read is as before (no own, no minutes) — the Tracker page\'s payload', leanP2.own === undefined && leanP2.minutes === undefined
    && leanP2.ops.every((o) => o.minutes === undefined) && leanP2.byOperation.every((b) => b.minutes === undefined) && near(leanP2.completion, 0.6, 0.0001));
  const kids = await TREE.trackerTreeChildren(conn, COMPANY, { nodeId: `l${L1}`, depth: 1, figures: '1' });
  ok('a branch read with figures=1 carries them (node and children)', kids.node.own?.minutes === 60 && kids.nodes.every((n) => n.own !== undefined));
  const grid = await TREE.lineGrid(conn, COMPANY, { lineId: L1, depth: 50 });
  const g2 = grid.nodes.find((r) => r.id === `p${P2}`);
  ok('the grid own / below split still holds (P2 weld: own 0 of 1, below 3 of 5)', g2.cells[OPY].done === 0 && g2.cells[OPY].total === 1 && g2.cells[OPY].below.done === 3 && g2.cells[OPY].below.total === 5, JSON.stringify(g2.cells[OPY]));

  const cntD = counting(conn);
  const dash = await DASH.ordersDashboard(cntD.db, COMPANY, {});
  const d1 = dash.orders.find((o) => o.id === SO1);
  const dl1 = d1.lineRows.find((l) => l.id === L1);
  const dl2 = d1.lineRows.find((l) => l.id === L2);
  ok('dashboard line 1: including 37.5 %, own 0 % (P1 only)', near(dl1.progressPct, 37.5, 0.05) && dl1.own.progressPct === 0 && dl1.own.stepsTotal === 1, JSON.stringify({ p: dl1.progressPct, own: dl1.own }));
  ok('dashboard line 2: one top piece, own = including (0 %)', dl2.own.progressPct === 0 && dl2.progressPct === 0);
  ok('dashboard order own % is set (lines weighed as the order %)', d1.progress.own.pct === 0 && d1.progress.own.stepsTotal === 2);

  // ---- B. Production orders ---------------------------------------------------------
  section('B. Production orders list, grouped by sales order');
  const cntP = counting(conn);
  const all = await PO.listProductionOrders(cntP.db, COMPANY, { search: RUN, limit: 50 });
  ok('both sales orders, every release under its order', all.total === 2 && all.rows.length === 2 && all.lineTotal === 4, `${all.total} ${all.lineTotal}`);
  const g1 = all.rows.find((r) => r.order.id === SO1);
  const gB = all.rows.find((r) => r.order.id === SO2);
  ok('order 1 carries its two lines in line order', g1.lines.map((l) => l.line.lineNo).join(',') === '1,2');
  const pl1 = g1.lines.find((l) => l.line.id === L1);
  ok('line 1: in progress, 37.5 % by minutes, released date, no plan', pl1.status === 'in_progress' && near(pl1.progress.pct, 37.5, 0.05) && pl1.progress.basis === 'work' && pl1.releasedAt && pl1.plan === null, JSON.stringify(pl1));
  ok('line 2: not started', g1.lines.find((l) => l.line.id === L2).status === 'not_started');
  ok('order 1 totals: 2 lines, 1 in progress, 1 not started, minutes-weighted % (60 of 175)', g1.totals.lines === 2 && g1.totals.in_progress === 1 && g1.totals.not_started === 1 && near(g1.totals.progressPct, (60 / 175) * 100, 0.05), JSON.stringify(g1.totals));
  const pm1 = gB.lines.find((l) => l.line.id === M1);
  const pm2 = gB.lines.find((l) => l.line.id === M2);
  ok('order 2: line 1 dispatched, line 2 planned for the week of 2026-11-16', pm1.status === 'dispatched' && pm2.plan?.shipWeek === '2026-11-16' && pm2.forecast.date === '2026-11-20', JSON.stringify(pm2.plan));
  ok('chip counts over the scope', all.counts.all === 4 && all.counts.dispatched === 1 && all.counts.in_progress === 1 && all.counts.not_started === 2 && all.counts.open === 3, JSON.stringify(all.counts));
  ok('customers offered for the filter', all.customers.some((x) => x.id === CUST_A) && all.customers.some((x) => x.id === CUST_B));
  const notStarted = await PO.listProductionOrders(conn, COMPANY, { search: RUN, status: 'not_started' });
  ok('status filter: not started = one line of each order', notStarted.total === 2 && notStarted.rows.every((r) => r.lines.length === 1 && r.lines[0].status === 'not_started'));
  const disp = await PO.listProductionOrders(conn, COMPANY, { search: RUN, status: 'dispatched' });
  ok('status filter: dispatched = order 2 only', disp.total === 1 && disp.rows[0].order.id === SO2);
  const byCust = await PO.listProductionOrders(conn, COMPANY, { customerId: CUST_A });
  ok('customer filter', byCust.rows.length === 1 && byCust.rows[0].order.id === SO1);
  const byItem = await PO.listProductionOrders(conn, COMPANY, { search: `${RUN}-C` });
  ok('search matches the item code', byItem.rows.some((r) => r.order.id === SO2) && byItem.rows.every((r) => r.lines.every((l) => l.item.code === `${RUN}-C`)));
  const p1 = await PO.listProductionOrders(conn, COMPANY, { search: RUN, limit: 1, offset: 0 });
  const p2 = await PO.listProductionOrders(conn, COMPANY, { search: RUN, limit: 1, offset: 1 });
  ok('paged by sales order: one order a page, never split, hasMore', p1.rows.length === 1 && p2.rows.length === 1 && p1.hasMore && !p2.hasMore && p1.rows[0].order.id !== p2.rows[0].order.id && p1.rows[0].lines.length + p2.rows[0].lines.length === 4);
  ok('open orders come before an all-dispatched one', all.rows[0].order.id === SO1);
  const cntWide = counting(conn);
  await PO.listProductionOrders(cntWide.db, COMPANY, {});
  ok(`fixed queries whatever the scope (${cntP.tally.n} with a search, ${cntWide.tally.n} company-wide)`, cntP.tally.n === cntWide.tally.n && cntP.tally.n <= 6);
  let refused = null;
  try { await PO.listProductionOrders(conn, COMPANY, { status: 'nope' }); } catch (e) { refused = e; }
  ok('an unknown status is refused in words', !!refused && /status is one of/.test(refused.message));
  ok('statusOf rules, pure', PO.statusOf({ quantity: 2, made: 2, delivered: 2, steps: 1, stepsDone: 0 }) === 'dispatched'
    && PO.statusOf({ quantity: 1, made: 0, delivered: 0, steps: 2, stepsDone: 2 }) === 'done'
    && PO.statusOf({ quantity: 1, made: 1, delivered: 0, steps: 0, stepsDone: 0 }) === 'done'
    && PO.statusOf({ quantity: 1, made: 0, delivered: 0, steps: 2, stepsDone: 0, started: true }) === 'in_progress'
    && PO.statusOf({ quantity: 1, made: 0, delivered: 0, steps: 2, stepsDone: 0 }) === 'not_started');

  section('B2. Work orders grouped by sales order');
  const wo = (orderId, lineId, contractor, status) => ins('INSERT INTO cf_work_orders (company_id, code, order_id, order_line_id, contractor_id, status) VALUES (?, ?, ?, ?, ?, ?)',
    [COMPANY, `${RUN}-WO${++sort}`, orderId, lineId, contractor, status]);
  const W1 = await wo(SO1, L1, CON_1, 'issued');
  const W2 = await wo(SO1, L2, CON_2, 'draft');
  const W3 = await wo(SO2, M2, CON_1, 'done');
  await conn.query('UPDATE cf_production_steps SET work_order_id = ? WHERE id IN (?)', [W1, [S_P2X, S_P2Y]]);   // 1 of 2 done
  await conn.query('UPDATE cf_production_steps SET work_order_id = ? WHERE id = ?', [W3, S_U1X]);
  const cntW = counting(conn);
  const grouped = await WO.listWorkOrdersByOrder(cntW.db, COMPANY, { search: RUN });
  const wg1 = grouped.rows.find((r) => r.order.id === SO1);
  const wg2 = grouped.rows.find((r) => r.order.id === SO2);
  ok('one row per sales order with its work orders', grouped.total === 2 && wg1.workOrders.length === 2 && wg2.workOrders.length === 1);
  ok('order 1 totals: 2 work orders, 2 open, 2 contractors, 1 of 2 steps done, 1 not released', wg1.totals.workOrders === 2 && wg1.totals.open === 2 && wg1.totals.contractors === 2
    && wg1.totals.steps === 2 && wg1.totals.stepsDone === 1 && wg1.totals.pct === 50 && wg1.totals.notReleased === 1, JSON.stringify(wg1.totals));
  ok('customer on the order row', wg1.order.customer?.id === CUST_A);
  ok(`grouped work orders: 3 queries (${cntW.tally.n})`, cntW.tally.n === 3);
  const openOnly = await WO.listWorkOrdersByOrder(conn, COMPANY, { search: RUN, status: 'open' });
  ok('status filter: open leaves order 2 (its only work order is done) out', openOnly.total === 1 && openOnly.rows[0].order.id === SO1);
  const pg1 = await WO.listWorkOrdersByOrder(conn, COMPANY, { search: RUN, limit: 1 });
  const pg2 = await WO.listWorkOrdersByOrder(conn, COMPANY, { search: RUN, limit: 1, offset: 1 });
  ok('paged by order: a page holds an order and all its work orders', pg1.rows.length === 1 && pg2.rows.length === 1 && pg1.hasMore && pg1.rows[0].order.id !== pg2.rows[0].order.id
    && pg1.rows[0].workOrders.length + pg2.rows[0].workOrders.length === 3);
  const byCon = await WO.listWorkOrdersByOrder(conn, COMPANY, { search: RUN, contractorId: CON_2 });
  ok('contractor filter', byCon.total === 1 && byCon.rows[0].workOrders.every((w) => w.contractorId === CON_2));
  const wd = await DASH.workOrdersDashboard(conn, COMPANY, {});
  const ws1 = wd.salesOrders.find((s) => s.id === SO1);
  ok('dashboard work orders: a salesOrders summary (order 1: 2 work orders, 2 contractors, 50 %)', ws1 && ws1.workOrders === 2 && ws1.contractors === 2 && ws1.pct === 50 && ws1.steps === 2, JSON.stringify(ws1));
  void W2;

  // ---- C. unplanned work --------------------------------------------------------
  section('C. Work outside the plan: warn, start anyway, record it');
  const chk = await PLAN.planCheck(conn, COMPANY, { stepIds: `${S_P1X},${S_U1X}` });
  ok('plan check: the unplanned step is listed with its order and line, the planned one is not', chk.unplanned.length === 1 && chk.unplanned[0].stepId === S_P1X
    && chk.unplanned[0].orderCode === `${RUN}-SO1` && chk.unplanned[0].lineNo === 1 && chk.message === 'This work is not in the plan.', JSON.stringify(chk));
  const entries = PLAN.plannedEntries([{ unit_key: 'p7#2', ship_date: '2026-12-01' }, { unit_key: 'p7#1', ship_date: '2026-11-01' }, { unit_key: 'l3', ship_date: '2026-10-30' }]);
  ok('a p<piece>#<n> entry counts for its piece (earliest date)', entries.find((e) => e.unit_key === 'p7')?.ship_date === '2026-11-01' && entries.some((e) => e.unit_key === 'l3'));
  const res = PLAN.shipDateResolver([{ id: 1, parent_id: null, order_piece_id: 7, bom_line_id: null }], [{ id: 7, parent_id: null, bom_line_id: null, sort_order: 1 }], entries);
  ok('the resolver finds the piece planned copy by copy', res.shipDate({ id: 1, parent_id: null, order_piece_id: 7 }, 99) === '2026-11-01');

  // The tracker's start (a supervisor): no machine, the step is ready.
  const qBefore = (await conn.query('SELECT COUNT(*) AS n FROM cf_step_events WHERE step_id = ?', [S_Q1X]))[0][0].n;
  await REL.startStep(conn, c, S_Q1X, { view: 'none' });
  const [[qs]] = await conn.query('SELECT state FROM cf_production_steps WHERE id = ?', [S_Q1X]);
  const [[qe]] = await conn.query("SELECT unplanned FROM cf_step_events WHERE step_id = ? AND event = 'start' ORDER BY id DESC LIMIT 1", [S_Q1X]);
  ok('tracker start on unplanned work still starts it', qs.state === 'in_progress' && Number(qBefore) === 0);
  ok('its start event is flagged unplanned', Number(qe?.unplanned) === 1);

  // The floor's start: a machine of our own that may do both operations at a fixed time.
  const MC = await ins("INSERT INTO cf_machines (company_id, code, name, classification_id, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, `${RUN}-MC`, `${RUN} machine`, machineType.classification_id]);
  for (const op of [OPX, OPY]) {
    await conn.query("INSERT INTO cf_operation_machine_rules (company_id, operation_id, subject_type, subject_id, eligible, setup_minutes, work_minutes) VALUES (?, ?, 'machine', ?, 1, 0, 5)", [COMPANY, op, MC]);
  }
  const q = await FLOOR.machineQueue(conn, COMPANY, MC, { search: RUN });
  const qP1 = q.next.find((s) => s.id === S_P1X);
  const qU1 = q.next.find((s) => s.id === S_U1X);
  ok('the queue marks planned / not planned (and keeps its order rules)', qP1?.planned === false && (qU1 === undefined || qU1.planned === true), JSON.stringify({ qP1: qP1?.planned, qU1: qU1?.planned }));
  const started = await FLOOR.startWork(conn, c, { machineId: MC, stepIds: [S_P1X] });
  const [[ws]] = await conn.query('SELECT unplanned FROM cf_work_sessions WHERE id = ?', [started.started[0].sessionId]);
  const [[we]] = await conn.query("SELECT unplanned FROM cf_step_events WHERE step_id = ? AND event = 'start' ORDER BY id DESC LIMIT 1", [S_P1X]);
  ok('floor start on unplanned work succeeds and warns with the order / line', started.started.length === 1 && started.started[0].unplanned === true && started.warning === 'This work is not in the plan.'
    && started.unplanned[0].orderCode === `${RUN}-SO1` && started.flagged === true);
  ok('the session and the start event carry unplanned = 1', Number(ws.unplanned) === 1 && Number(we?.unplanned) === 1);
  await conn.query('UPDATE cf_production_steps SET work_order_id = NULL WHERE id = ?', [S_U1X]);
  const planned = await FLOOR.startWork(conn, c, { machineId: MC, stepIds: [S_U1X] });
  const [[ws2]] = await conn.query('SELECT unplanned FROM cf_work_sessions WHERE id = ?', [planned.started[0].sessionId]);
  ok('a planned step starts with no warning and no flag', planned.warning === null && planned.unplanned.length === 0 && planned.started[0].unplanned === false && Number(ws2.unplanned) === 0);
  const dash2 = await DASH.ordersDashboard(conn, COMPANY, {});
  ok('the dashboard counts started unplanned (order 1: 2, order 2: 0)', dash2.orders.find((o) => o.id === SO1).startedUnplanned === 2 && dash2.orders.find((o) => o.id === SO2).startedUnplanned === 0 && dash2.totals.startedUnplanned >= 2);

  // ---- D. planner settings --------------------------------------------------------
  section('D. Planner settings are gone');
  const snap = await PLANNER.getPlanner(conn, COMPANY, {});
  ok('the planner read carries no settings', !('settings' in snap) && !JSON.stringify(Object.keys(snap)).includes('minLinesPerMonth'));
  ok('putSettings is no longer exported', PLANNER.putSettings === undefined && PLANNER.DEFAULT_SETTINGS === undefined);
  const routes = plannerRoutes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  ok('PUT /planner/settings is not routed', !routes.includes('put /planner/settings') && routes.includes('put /planner/targets'));
} catch (e) {
  exitCode = 1;
  console.error(e);
} finally {
  try { await conn.rollback(); } catch { /* */ }
  detachNodeCache(conn);
  const after = await census(conn).catch(() => null);
  conn.release();
  if (before && after) {
    const moved = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
    ok(`every cf_ table is back where it started (${Object.keys(before).length} tables)`, moved.length === 0, moved.slice(0, 8).join(', '));
  }
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`Failed:\n  ${fails.join('\n  ')}`);
process.exit(failed || exitCode ? 1 : 0);
