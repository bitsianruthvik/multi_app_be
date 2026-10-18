/**
 * speed_audit.mjs — what each cf_erp screen's load costs in database round trips.
 *
 * Calls the service function behind each main GET a screen fires on load, on a
 * counting connection, and records per read:
 *   q      queries sent
 *   depth  the longest chain of queries each waiting for the one before
 *          (measured with the simulated latency below: a query is one level
 *          deeper than the deepest query that had finished when it was sent)
 *   ms     local wall time (no added latency)
 *   prod   wall time with SPEED_LATENCY ms (default 49, TiDB Cloud's round trip)
 *          added to every query, at most SPEED_POOL (10, DB_POOL_SIZE) at once —
 *          what the read costs on production, roughly
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/speed_audit.mjs                 table of every read
 *   node scripts/cf_kepl/speed_audit.mjs --only=dash     reads whose label holds "dash"
 *   node scripts/cf_kepl/speed_audit.mjs --json=out.json also write the rows
 *   node scripts/cf_kepl/speed_audit.mjs --trace         every query of every read
 *   node scripts/cf_kepl/speed_audit.mjs --check         and fail when a read takes a longer chain than its budget (BUDGET)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. To give the
 * production reads something to read it borrows the KEPL line (923, company 2)
 * as tracker_tree_test does: locked if not, its order confirmed, the line
 * released — then rolled back. Line 923 is NEVER left released; the script
 * re-counts every cf_ table at the end and fails loudly if anything moved.
 * Writes nothing; changes nothing.
 */
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const { invalidateTrackerCache } = await imp('apps/cf_erp/lib/trackerCache.js');
const S = (p) => imp(`apps/cf_erp/services/${p}.js`);
const REL = await S('releaseService');
const LOCK = await S('lockService');
const SO = await S('salesOrderService');
const AREAS = await S('stockingAreaService');
const OV = await S('overviewService');
const APPR = await S('approvalService');
const BILL = await S('billingService');
const DASH = await S('dashboardService');
const PROC = await S('processService');
const PO = await S('productionOrderService');
const POS = await S('productionOrdersService');
const TREE = await S('trackerTreeService');
const PUR = await S('purchaseService');
const PR = await S('purchaseRequestService');
const GRN = await S('grnService');
const PMS = await S('procurementMethodService');
const MAINT = await S('maintenanceService');
const COST = await S('costingService');
const RCPT = await S('receiptService');
const MR = await S('masterRecordService');
const PLAN = await S('plannerService');
const PLAN3 = await S('plannerV3Service');
const BOARD = await S('orderBoardService');
const ACC = await S('acceptanceService');
const SV = await S('stockViewService');
const BATCH = await S('batchService');
const STOCK = await S('stockService');
const INV = await S('invoiceService');
const VAL = await S('valuationService');
const REQ = await S('requisitionService');
const MRD = await S('materialReadyService');
const OVS = await S('orderValuesService');
const NEST = await S('nestingService');
const EXEC = await S('executionPlanService');
const MACH = await S('machineService');
const FLOW = await S('flowService');
const OPS = await S('operationService');

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const ONLY = arg('only');
const JSON_OUT = arg('json');
const TRACE = process.argv.includes('--trace');
const CHECK = process.argv.includes('--check');
/*
 * --check: the longest chains (depth) of the reads made side by side on 2026-10-19 may not grow
 * back. Before → budget: nav-counts 8 → 3, Home 14 → 3, order detail 5 → 3, orders list 4 → 3,
 * acceptance 7 → 3, purchase order 8 → 4, order costs 9 → 4, cost sheet 11 → 5, execution plan
 * 9 → 4, production orders 10 → 4, order process 16 → 10, planner 20 → 14; and the order
 * structure (one connection: every query waits for the last) 16 → 12 queries.
 */
const BUDGET = {
  'shell  nav-counts': { depth: 3 }, 'shell  cockpit': { depth: 3 }, 'order  detail': { depth: 3 }, 'orders list': { depth: 3 },
  'order  acceptance': { depth: 3 }, 'buy    purchase order': { depth: 4 }, 'order  costs': { depth: 4 }, 'acct   cost sheet': { depth: 5 },
  'order  execution plan': { depth: 4 }, 'order  production orders': { depth: 4 }, 'order  process': { depth: 10 }, 'plan   planner': { depth: 14 },
  'order  structure (tx)': { q: 12 },
};
const COMPANY = Number(process.env.SPEED_COMPANY ?? 2);
const LINE = Number(process.env.SPEED_LINE ?? 923);
const LATENCY = Number(process.env.SPEED_LATENCY ?? 49);
const POOL = Number(process.env.SPEED_POOL ?? 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A connection that counts, and (latency > 0) waits `latency` ms per query, `cap` at once, like a pool to TiDB. */
function counting(conn, { latency = 0, cap = POOL } = {}) {
  const tally = { n: 0, spans: [], sql: [], t0: Date.now() };
  let slots = cap;
  const waiting = [];
  const take = () => (slots > 0 ? (slots -= 1, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const give = () => { const next = waiting.shift(); if (next) next(); else slots += 1; };
  const db = new Proxy(conn, {
    get: (target, prop) => (prop === 'query' || prop === 'execute'
      ? async (...args) => {
        tally.n += 1;
        const span = { start: performance.now(), end: Infinity };
        tally.spans.push(span);
        const t = Date.now();
        try {
          if (latency > 0) { await take(); try { await sleep(latency); return await target[prop](...args); } finally { give(); } }
          return await target[prop](...args);
        } finally {
          span.end = performance.now();
          if (TRACE) tally.sql.push(`@${String(t - tally.t0).padStart(5)} ${String(Date.now() - t).padStart(5)} ms  ${String(args[0]?.sql ?? args[0]).replace(/\s+/g, ' ').slice(0, 110)}`);
        }
      }
      : Reflect.get(target, prop)),
  });
  return { db, tally };
}

/** The longest chain: each query one deeper than the deepest that had finished before it was sent. */
function depthOf(spans) {
  const level = [];
  spans.forEach((q, i) => {
    let deepest = 0;
    for (let j = 0; j < i; j++) if (spans[j].end <= q.start) deepest = Math.max(deepest, level[j]);
    level[i] = deepest + 1;
  });
  return level.length ? Math.max(...level) : 0;
}

async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}

const conn = await pool.getConnection();
const rows = [];
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    'SELECT l.id, l.locked_at, l.order_id, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?',
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — it must not be; stopping.`);
  const ORDER = line.order_id;
  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, ORDER]);
    await SO.setOrderStatus(conn, c, ORDER, 'confirmed');
  }
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: 'SPD-DSP', name: 'Speed audit dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const rel = await REL.releaseLine(conn, c, LINE, check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {});
  const [[po]] = await conn.query('SELECT id FROM cf_purchase_orders WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]);
  const [[prodOrder]] = await conn.query('SELECT id FROM cf_production_orders WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]).catch(() => [[null]]);
  const [[item]] = await conn.query("SELECT id FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND record_kind = 'item' ORDER BY id LIMIT 1", [COMPANY]);
  console.log(`Company ${COMPANY}, order ${ORDER}, line ${LINE} released inside the transaction (${rel.items.length} pieces/groups); latency ${LATENCY} ms, pool ${POOL}\n`);

  const all = () => true;
  const CASES = [
    // Shell
    ['shell  nav-counts (route: counts + approvals + billing due)', (db) => Promise.all([OV.navCounts(db, COMPANY), APPR.pendingCount(db, COMPANY, all), BILL.billingDueCount(db, COMPANY).catch(() => 0)])],
    ['shell  cockpit (Home)', (db) => OV.cockpit(db, COMPANY)],
    ['shell  search "SO"', (db) => OV.search(db, COMPANY, 'SO')],
    // Orders
    ['orders list', (db) => SO.listOrders(db, COMPANY, {})],
    ['orders order-board', (db) => BOARD.orderBoard(db, COMPANY, {})],
    ['order  detail', (db) => SO.getOrder(db, COMPANY, ORDER)],
    ['order  structure (tx)', (db) => SO.orderStructure(db, COMPANY, ORDER, { c })],
    ['order  line structure (tx)', (db) => SO.lineStructure(db, COMPANY, LINE, { c })],
    ['order  process', (db) => PROC.orderProcess(db, COMPANY, ORDER)],
    ['order  production summary', (db) => REL.orderProductionSummary(db, COMPANY, ORDER)],
    ['order  production orders', (db) => PO.getOrderProductionOrders(db, COMPANY, ORDER)],
    ['order  acceptance', (db) => ACC.getAcceptance(db, COMPANY, ORDER)],
    ['order  events', (db) => ACC.orderEvents(db, COMPANY, ORDER)],
    ['order  execution plan', (db) => EXEC.getExecutionPlan(db, COMPANY, ORDER)],
    ['order  requisitions', (db) => REQ.orderRequisitions(db, COMPANY, ORDER)],
    ['order  line material-ready', (db) => MRD.lineMaterialReady(db, COMPANY, LINE)],
    ['order  line values', (db) => OVS.readLineValues(db, COMPANY, LINE)],
    ['order  costs', (db) => VAL.orderCosts(db, COMPANY, ORDER)],
    ['order  invoices', (db) => INV.orderInvoices(db, COMPANY, ORDER)],
    ['order  nesting panel (GET nesting)', (db) => NEST.getNesting(db, COMPANY, LINE)],
    // Production
    ['prod   tracker tree (all)', (db) => TREE.trackerTree(db, COMPANY, {})],
    ['prod   tracker steps', (db) => REL.listTrackerSteps(db, COMPANY, {})],
    ['prod   tracker materials', (db) => REL.listTrackerMaterials(db, COMPANY, {})],
    ['prod   released lines', (db) => POS.listProductionOrders(db, COMPANY, {})],
    ['prod   production orders list', (db) => PO.listProductionOrders(db, COMPANY, {})],
    ...(prodOrder ? [['prod   production order', (db) => PO.readProductionOrder(db, COMPANY, prodOrder.id)]] : []),
    ['prod   machines', (db) => MACH.listMachines(db, COMPANY, {})],
    ['prod   flows', (db) => FLOW.listFlows(db, COMPANY, {})],
    ['prod   operations', (db) => OPS.listOperations(db, COMPANY, {})],
    ['dash   machines', (db) => DASH.machinesDashboard(db, COMPANY, {})],
    ['dash   orders', (db) => DASH.ordersDashboard(db, COMPANY, {}, { withMoney: true })],
    ['dash   work-orders', (db) => DASH.workOrdersDashboard(db, COMPANY, {})],
    ['plan   planner', (db) => PLAN.getPlanner(db, COMPANY, {})],
    ['plan   planner3', (db) => PLAN3.getPlanner3(db, COMPANY, {})],
    ['plan   planner3 health', (db) => PLAN3.planHealth(db, COMPANY)],
    // Management / buying
    ['mgmt   approvals', (db) => APPR.listApprovals(db, COMPANY, all, {})],
    ['buy    material requests', (db) => PR.listMrs(db, COMPANY, {})],
    ['buy    purchase requests', (db) => PR.listPrs(db, COMPANY, {})],
    ['buy    purchase orders', (db) => PUR.listPurchaseOrders(db, COMPANY, {})],
    ...(po ? [['buy    purchase order', (db) => PUR.getPurchaseOrder(db, COMPANY, po.id)]] : []),
    ['buy    pending lines', (db) => PUR.pendingLines(db, COMPANY, {})],
    ['buy    grn bills', (db) => GRN.listBills(db, COMPANY, {})],
    ['store  reorder', (db) => PMS.reorderSuggestions(db, COMPANY, {})],
    ['store  stock view', (db) => SV.stockView(db, COMPANY, {})],
    ['store  batches', (db) => BATCH.listBatches(db, COMPANY, {})],
    ['store  movements', (db) => STOCK.listMovements(db, COMPANY, {})],
    ['store  areas', (db) => AREAS.listAreas(db, COMPANY, {})],
    ['maint  board (tx)', (db) => MAINT.machinesBoard(db, c)],
    ['maint  summary', (db) => MAINT.maintenanceSummary(db, COMPANY)],
    ['maint  orders', (db) => MAINT.listOrders(db, COMPANY, {})],
    ['maint  plans (tx)', (db) => MAINT.listPlans(db, c, {})],
    ['acct   costing list', (db) => COST.costingList(db, COMPANY, {})],
    ['acct   cost sheet', (db) => COST.costSheet(db, COMPANY, ORDER)],
    ['acct   billing board (tx)', (db) => BILL.billingBoard(db, c, {}, { observe: true })],
    ['acct   receipts', (db) => RCPT.listReceipts(db, COMPANY, {})],
    ['acct   invoices', (db) => INV.listInvoices(db, COMPANY, {})],
    ['cat    records (items)', (db) => MR.listRecords(db, COMPANY, { kind: 'item' })],
    ['cat    records (definitions)', (db) => MR.listRecords(db, COMPANY, { kind: 'definition' })],
    ...(item ? [['cat    record detail', (db) => MR.getRecord(db, COMPANY, item.id)]] : []),
  ];

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log(`${pad('read', 58)}${lpad('q', 5)}${lpad('depth', 7)}${lpad('ms', 7)}${lpad('prod ms', 9)}`);
  for (const [label, fn] of CASES) {
    if (ONLY && !label.includes(ONLY)) continue;
    const row = { label };
    try {
      await conn.query('SAVEPOINT speed_case');
      invalidateTrackerCache();
      const a = counting(conn);
      let t = Date.now();
      await fn(a.db);
      row.q = a.tally.n; row.ms = Date.now() - t;
      await conn.query('ROLLBACK TO SAVEPOINT speed_case');
      invalidateTrackerCache();
      const b = counting(conn, { latency: LATENCY });
      t = Date.now();
      await fn(b.db);
      row.prod = Date.now() - t; row.depth = depthOf(b.tally.spans);
      await conn.query('ROLLBACK TO SAVEPOINT speed_case');
      console.log(`${pad(label, 58)}${lpad(row.q, 5)}${lpad(row.depth, 7)}${lpad(row.ms, 7)}${lpad(row.prod, 9)}`);
      if (TRACE) for (const s of b.tally.sql) console.log(`      ${s}`);
    } catch (err) {
      row.error = String(err?.message ?? err).slice(0, 140);
      console.log(`${pad(label, 58)}  ERROR ${row.error}`);
      try { await conn.query('ROLLBACK TO SAVEPOINT speed_case'); } catch { /* the transaction may be gone */ }
    }
    rows.push(row);
  }
  const done = rows.filter((r) => r.q != null);
  if (CHECK) {
    console.log('\nBudgets');
    for (const [prefix, b] of Object.entries(BUDGET)) {
      const r = rows.find((x) => x.label.startsWith(prefix));
      if (!r) continue;
      const good = r.q != null && (b.depth == null || r.depth <= b.depth) && (b.q == null || r.q <= b.q);
      console.log(`  ${good ? 'PASS' : 'FAIL'}  ${prefix.replace(/\s+/g, ' ')}: ${b.depth != null ? `depth ${r.depth} ≤ ${b.depth}` : `${r.q} queries ≤ ${b.q}`}${r.error ? ` — ${r.error}` : ''}`);
      if (!good) exitCode = 1;
    }
  }
  console.log(`\n${done.length} reads: ${done.reduce((t, r) => t + r.q, 0)} queries, ${done.reduce((t, r) => t + r.prod, 0)} ms simulated on production`);

  await conn.rollback();
  const after = await census(conn);
  const moved = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
  // This script writes nothing outside its rolled-back transaction: a count that moved was moved by another
  // process (another agent's suite on the shared database) — rerun when it is quiet.
  if (moved.length) { console.log(`\nFAIL: tables changed while it ran (another process writing?): ${moved.join(', ')}`); exitCode = 1; }
  const [[still]] = await conn.query('SELECT COUNT(*) AS n FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  if (Number(still.n)) { console.log(`\nFAIL: line ${LINE} is released`); exitCode = 1; } else console.log(`Rolled back: every cf_ table as it was; line ${LINE} not released.`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below matters */ }
  console.error(err);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
  process.exit(exitCode);
}
