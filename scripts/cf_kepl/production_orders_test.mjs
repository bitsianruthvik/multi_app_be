/**
 * production_orders_test.mjs — STEP 4 (init.sql §76): times per quantity, production orders, production on the new
 * release, the order's time override. Local DB only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/production_orders_test.mjs
 *   CF_PO_COMPANY (2)
 *
 *   A. pure: setup per quantity (stepMinutes), the plan's production orders per line / unit / sub-assembly (+ the
 *      rest), which production order each piece belongs to (assignPieces), the states (stateOf)
 *   B. create from the execution plan: refused before confirmation, line and order levels, a line released the old
 *      way joins as Planned and its pieces are stamped, idempotent, dry run
 *   C. release: a step of a production order Yet to plan cannot start (tracker start, floor start, machine queue);
 *      release → Planned, stamped, it starts; take back refused once started, allowed before (the line's release goes)
 *   D. dispatch: refused before the last step; a stock order's finished production order closes; a customer's with
 *      nothing finished says so
 *   E. the order's time override: set → every not-done step N s setup + N s a piece; the Times grid and the estimator
 *      say so; cleared → the formulas again
 *   F. nesting is frozen once a line has a production order; the list / read services; fixed reads
 *
 * Its own TEST-PO-… orders, built straight into the tables (release itself is release_batch_test's), INSIDE ONE
 * TRANSACTION THAT IS ROLLED BACK; the last thing it does is re-count every cf_ table. Line 923 is never touched.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const MODEL = await imp('apps/cf_erp/services/productionOrderModel.js');
const POS = await imp('apps/cf_erp/services/productionOrderService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const FLOOR = await imp('apps/cf_erp/services/floorService.js');
const TIMES = await imp('apps/cf_erp/services/timeEstimateService.js');
const NEST = await imp('apps/cf_erp/services/nestingService.js');
const TREE = await imp('apps/cf_erp/services/trackerTreeService.js');
const routes = (await imp('apps/cf_erp/routes/productionOrders.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PO_COMPANY ?? 2);
const RUN = `TEST-PO-${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (s) => console.log(`\n${s}`);
const near = (a, b, tol = 0.0005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, { get: (t, p) => (p === 'query' ? (...a) => { tally.n += 1; return t.query(...a); } : Reflect.get(t, p)) });
  return { db: proxy, tally };
}

// ---- A. pure ------------------------------------------------------------------------
section('A. Pure: setup per quantity, the plan\'s production orders, pieces, states');
ok('a step of 4 pieces at setup 2 + work 3 min a piece takes (2 + 3) × 4 = 20 min', TIMES.stepMinutes(2, 3, 4) === 20);
ok('no work time: no minutes', TIMES.stepMinutes(2, null, 4) === null);
{
  // A line of 2 spans: each span has 2 girder lines (definition 10, row 501) with a segment under each, and a loose
  // item (row 502). Per sub-assembly of "Girder line": 2 a span + the rest of each span = 6.
  const seg = { id: 3, lineId: 503, code: null, name: 'Segment', quantity: 1, children: [] };
  const girder = { id: 2, lineId: 501, code: null, name: 'Girder line', quantity: 2, children: [seg] };
  const loose = { id: 4, lineId: 502, code: null, name: 'Bolt set', quantity: 1, children: [] };
  const tree = { root: { id: 1, code: 'SO-X', name: 'Span', quantity: 2, children: [girder, loose] } };
  const defOf = (id) => (Number(id) === 2 ? { id: 10, name: 'Girder line' } : null);
  const shape = { levels: [{ id: 10, name: 'Girder line', perUnit: 2 }], outside: new Map([[10, true]]), hasRootFlow: false };
  const line = (plan, qty = 2) => ({ lineId: 77, lineNo: 1, quantity: qty, itemName: 'Span', plan, shape, tree });
  const P = (level, levelId = null) => ({ production: { level, levelId }, dispatch: { level: 'same', levelId: null } });
  const asm = MODEL.plannedProductionOrders('SO260014', [line(P('assembly', 10))], defOf);
  ok('per sub-assembly: 2 girder lines + the rest, for each of 2 spans = 6', asm.length === 6, asm.map((x) => x.scopeKey).join(' '));
  ok('labels read simply: "SO260014 · Span 2 of 2 · Girder line #1"', asm.some((x) => x.label === 'SO260014 · Span 2 of 2 · Girder line #1') && asm.some((x) => x.label === 'SO260014 · Span 1 of 2 · the rest and final assembly'), asm.map((x) => x.label).join(' | '));
  ok('scope keys name unit, level, BOM path and instance', asm[0].scopeKey === 'L77U1A10:501#1' && asm[1].scopeKey === 'L77U1A10:501#2' && asm[2].scopeKey === 'L77U1R');
  const unit = MODEL.plannedProductionOrders('SO260014', [line(P('unit'))], defOf);
  ok('per unit: "SO260014 · Span 1 of 2", "… 2 of 2"', unit.length === 2 && unit[1].label === 'SO260014 · Span 2 of 2' && unit[1].unitNo === 2);
  const whole = MODEL.plannedProductionOrders('SO260014', [line(P('line'))], defOf);
  ok('per line: one, "SO260014 · Span ×2"', whole.length === 1 && whole[0].label === 'SO260014 · Span ×2' && whole[0].scopeKey === 'L77');
  const frac = MODEL.plannedProductionOrders('SO260014', [line(P('unit'), 2.5)], defOf);
  ok('a quantity that is not whole is made per line', frac.length === 1 && frac[0].level === 'line');
  const two = MODEL.plannedProductionOrders('SO260014', [{ ...line(P('order')), lineId: 1 }, { ...line(P('order')), lineId: 2, lineNo: 2 }], defOf);
  ok('the order level: one for every line on it', two.length === 1 && two[0].scopeKey === 'O' && two[0].lineIds.join(',') === '1,2' && two[0].label === 'SO260014 · whole order');

  // The tracker of that line (release order): unit roots, girder pieces (row 501), their segments, the loose item.
  let k = 0;
  const items = [];
  const add = (id, parent, depth, bom, itemId, pieceNo = 1, quantity = 1) => items.push({ id, parent_id: parent, depth, sort_order: ++k, bom_line_id: bom, item_id: itemId, piece_no: pieceNo, quantity });
  for (const u of [0, 1]) {
    const r = 100 + u * 10;
    add(r, null, 0, null, 1);
    add(r + 1, r, 1, 501, 2); add(r + 2, r + 1, 2, 503, 3);
    add(r + 3, r, 1, 501, 2); add(r + 4, r + 3, 2, 503, 3);
    add(r + 5, r, 1, 502, 4, null, 1);
  }
  const orders = asm.map((x, i) => ({ id: 900 + i, scope_key: x.scopeKey, level: x.level, level_id: x.levelId }));
  const map = MODEL.assignPieces(77, items, orders, (id) => defOf(id));
  const po = (key) => orders.find((o) => o.scope_key === key).id;
  ok('span 1: girder 1 and its segment → its order; girder 2 → the next', map.get(101) === po('L77U1A10:501#1') && map.get(102) === po('L77U1A10:501#1') && map.get(103) === po('L77U1A10:501#2') && map.get(104) === po('L77U1A10:501#2'));
  ok('span 1 itself and its loose item → the rest and final assembly', map.get(100) === po('L77U1R') && map.get(105) === po('L77U1R'));
  ok('span 2 pieces → span 2\'s orders', map.get(111) === po('L77U2A10:501#1') && map.get(113) === po('L77U2A10:501#2') && map.get(110) === po('L77U2R'));
  const uMap = MODEL.assignPieces(77, items, unit.map((x, i) => ({ id: 800 + i, scope_key: x.scopeKey, level: x.level, level_id: null })), defOf);
  ok('per unit: every piece of span 2 → span 2\'s order', [110, 111, 112, 113, 114, 115].every((i) => uMap.get(i) === 801) && uMap.get(104) === 800);
}
ok('states: yet to plan / planned / in production / dispatch / closed',
  MODEL.stateOf('yet_to_plan', { steps: 3 }) === 'yet_to_plan' && MODEL.stateOf('planned', { steps: 3, done: 0, started: 0 }) === 'planned'
  && MODEL.stateOf('planned', { steps: 3, done: 1, started: 2 }) === 'in_production' && MODEL.stateOf('planned', { steps: 3, done: 3, started: 3 }) === 'dispatch'
  && MODEL.stateOf('closed', { steps: 3, done: 3 }) === 'closed');
const routeList = routes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
ok('routes: create, release (before :id), take back, dispatch, time override', ['post /orders/:id/production-orders', 'post /production-orders/release', 'post /production-orders/:id/take-back',
  'post /production-orders/:id/dispatch', 'put /orders/:id/time-override', 'get /production-orders/:id'].every((r) => routeList.includes(r))
  && routeList.indexOf('post /production-orders/release') < routeList.indexOf('get /production-orders/:id'));

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
  console.log(`\nCompany ${COMPANY} — run ${RUN}`);

  // ---- fixture ---------------------------------------------------------------------
  const [[node]] = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope IN ('item','both') AND deleted_at IS NULL ORDER BY depth DESC, id LIMIT 1", [COMPANY]);
  const [[flow]] = await conn.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const [[mc]] = await conn.query("SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1", [COMPANY]);
  const master = async (key) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, node.id]);
    await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'make')", [id, COMPANY]);
    return id;
  };
  const CUST = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-CUST`, `${RUN} customer`]);
  const OPX = await ins("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, 'TPO Assemble', 'active')", [COMPANY, `${RUN}-X`]);
  if (mc) await conn.query("INSERT INTO cf_operation_machine_rules (company_id, operation_id, subject_type, subject_id, eligible, setup_minutes, work_minutes) VALUES (?, ?, 'machine', ?, 1, 0, 5)", [COMPANY, OPX, mc.id]);
  const A = await master('A');
  const B = await master('B');
  const order = (key, status, type = 'customer') => ins('INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id) VALUES (?, ?, ?, ?, ?, ?)',
    [COMPANY, `${RUN}-${key}`, type, `PO test ${key}`, status, type === 'customer' ? CUST : null]);
  const line = (orderId, lineNo, item, qty) => ins(
    "INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, ?, 'standard', ?, ?, ?, ?)",
    [COMPANY, orderId, lineNo, item, item, lineNo, qty]);
  const plan = (orderId, level) => conn.query("INSERT INTO cf_order_execution_plans (company_id, order_id, order_line_id, production_level, dispatch_level) VALUES (?, ?, NULL, ?, 'same')", [COMPANY, orderId, level]);
  const release = (orderId, lineId, item, qty) => ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, ?)', [COMPANY, orderId, lineId, item, qty]);
  let sort = 0;
  const piece = (rel, parent, item, depth, code) => ins(
    'INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, quantity, piece_no, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)',
    [COMPANY, rel, parent, item, code, flow.id, depth, ++sort]);
  const step = (itemId, qty, extra = {}) => ins(
    'INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, quantity, state, qty_good, est_setup_minutes, est_work_minutes, est_minutes) VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?, ?)',
    [COMPANY, itemId, OPX, qty, extra.state ?? 'pending', extra.good ?? 0, 1, 2, (1 + 2) * qty]);

  // ---- B. create -------------------------------------------------------------------------
  section('B. Create production orders from the execution plan');
  const SOQ = await order('Q', 'quoted');
  await line(SOQ, 1, A, 1);
  await plan(SOQ, 'line');
  const early = await refusal(() => POS.createProductionOrders(conn, c, SOQ));
  ok('refused before the customer\'s acceptance is approved (the order is not confirmed)', early?.code === 'NOT_READY' && /acceptance/.test(early.message), early?.message);

  const SO1 = await order('SO1', 'confirmed');
  const L11 = await line(SO1, 1, A, 1);
  const L12 = await line(SO1, 2, B, 3);
  await plan(SO1, 'line');
  // Line 1 was released the old way: its tracker exists already.
  const R11 = await release(SO1, L11, A, 1);
  const P11 = await piece(R11, null, A, 0, `${RUN}-SO1-A`);
  const S11 = await step(P11, 1);
  const dry = await POS.createProductionOrders(conn, c, SO1, { dryRun: true });
  ok('dry run: 2 production orders, nothing written', dry.toCreate === 2 && dry.labels.length === 2, JSON.stringify(dry));
  const made = await POS.createProductionOrders(conn, c, SO1, {});
  const pos1 = made.productionOrders;
  ok('created one per line, coded <order>-P01 / -P02', made.created === 2 && pos1.map((p) => p.code).join(',') === `${RUN}-SO1-P01,${RUN}-SO1-P02`, pos1.map((p) => p.code).join(','));
  ok('labels: "<order> · Line 2 · <item> ×3"', pos1[1].label === `${RUN}-SO1 · Line 2 · ${RUN} B ×3`, pos1[1].label);
  const po11 = pos1.find((p) => p.line?.id === L11);
  const po12 = pos1.find((p) => p.line?.id === L12);
  ok('line 1 (released before) joins as Planned; line 2 is Yet to plan', po11.status === 'planned' && po11.state === 'planned' && po12.state === 'yet_to_plan');
  const [[stamp11]] = await conn.query('SELECT production_order_id AS po FROM cf_production_steps WHERE id = ?', [S11]);
  ok('the old release\'s pieces and steps are stamped with their production order', Number(stamp11.po) === po11.id);
  ok('the order view: nothing left to create, no older release left unjoined, counts by state', made.toCreate.count === 0 && made.legacy.length === 0 && made.counts.planned === 1 && made.counts.yet_to_plan === 1);
  const again = await refusal(() => POS.createProductionOrders(conn, c, SO1, {}));
  ok('creating again is refused — every one exists', again?.code === 'NOTHING_TO_CREATE');

  const SO2 = await order('SO2', 'confirmed');
  await line(SO2, 1, A, 1);
  await line(SO2, 2, B, 1);
  await plan(SO2, 'order');
  const whole = await POS.createProductionOrders(conn, c, SO2, {});
  ok('the order level: one production order for both lines', whole.productionOrders.length === 1 && whole.productionOrders[0].level === 'order' && whole.productionOrders[0].lineIds.length === 2
    && whole.productionOrders[0].label === `${RUN}-SO2 · whole order`);

  // ---- C. release -------------------------------------------------------------------------
  section('C. Release: Yet to plan cannot start; released, it can');
  // Line 2's tracker (as the release engine would write it), its production order still Yet to plan.
  const R12 = await release(SO1, L12, B, 3);
  const P12 = await piece(R12, null, B, 0, `${RUN}-SO1-B`);
  const S12 = await step(P12, 3);
  await POS.stampLines(conn, c, [L12]);
  const tr = await REL.listTrackerSteps(conn, COMPANY, { productionOrderId: po12.id, search: RUN });
  ok('the tracker lists the production order\'s step, with its code and why it waits', tr.length === 1 && tr[0].productionOrder?.code === po12.code && tr[0].status === 'not_ready'
    && tr[0].blockers.some((b) => b.kind === 'production_order'), JSON.stringify(tr[0]?.blockers));
  const noStart = await refusal(() => REL.startStep(conn, c, S12, { allowNotReady: true }));
  ok('a tracker start is refused, even "it really was done"', noStart?.code === 'NOT_RELEASED' && /not released yet/.test(noStart.problems?.[0] ?? ''), noStart?.message);
  if (mc) {
    const q = await FLOOR.machineQueue(conn, COMPANY, mc.id, { search: RUN, limit: 500 });
    ok('the machine queue leaves it out', !q.next.some((s) => s.id === S12));
    const floorNo = await refusal(() => FLOOR.startWork(conn, c, { machineId: mc.id, stepIds: [S12] }));
    ok('a floor start is refused in words', !!floorNo && JSON.stringify(floorNo.problems ?? floorNo.message).includes('is not released yet'), floorNo?.message);
  }
  const rel = await POS.releaseProductionOrders(conn, c, { ids: [po12.id] });
  ok('released: Planned, nothing new released (the line was)', rel.released[0] === po12.code && rel.productionOrders[0].state === 'planned' && rel.fromMr.length === 0);
  const twice = await refusal(() => POS.releaseProductionOrders(conn, c, { ids: [po12.id] }));
  ok('releasing again is refused', twice?.code === 'NOT_RELEASABLE');
  if (mc) {
    const q2 = await FLOOR.machineQueue(conn, COMPANY, mc.id, { search: RUN, limit: 500 });
    const row = q2.next.find((s) => s.id === S12);
    ok('now on the machine queue, carrying its production order', !!row && row.productionOrder?.id === po12.id);
  }
  await REL.startStep(conn, c, S12, {});
  const [[st]] = await conn.query('SELECT state FROM cf_production_steps WHERE id = ?', [S12]);
  ok('the step starts', st.state === 'in_progress');
  const [after12] = await POS.listProductionOrdersOf(conn, COMPANY, { ids: [po12.id] });
  ok('the production order is In production', after12.state === 'in_production' && after12.stateLabel === 'In production');
  const tb = await refusal(() => POS.takeBackProductionOrder(conn, c, po12.id));
  ok('take back refused once something started', tb?.code === 'STARTED');
  // Take back line 1's (nothing started): the line's release goes back too.
  const back = await POS.takeBackProductionOrder(conn, c, po11.id);
  const [[r11]] = await conn.query('SELECT deleted_at FROM cf_production_releases WHERE id = ?', [R11]);
  ok('take back: Yet to plan, and the line\'s release is taken back with it', back.productionOrder.state === 'yet_to_plan' && back.releasesTakenBack === 1 && r11.deleted_at != null);
  const treePo = await TREE.trackerTree(conn, COMPANY, { productionOrderId: po12.id, depth: 6 });
  ok('the Tracker scoped to a production order shows its pieces', treePo.productionOrder?.id === po12.id && treePo.nodes.some((n) => n.id === `p${P12}`) && treePo.nodes.every((n) => n.kind !== 'piece' || n.productionOrderId === po12.id));

  // ---- D. dispatch -------------------------------------------------------------------------
  section('D. Dispatch');
  const notDone = await refusal(() => POS.dispatchProductionOrder(conn, c, po12.id));
  ok('refused while steps are still to do', notDone?.code === 'NOT_FINISHED' && /steps still to do/.test(notDone.message));
  await conn.query("UPDATE cf_production_steps SET state = 'done', qty_good = quantity WHERE id = ?", [S12]);
  const [doneState] = await POS.listProductionOrdersOf(conn, COMPANY, { ids: [po12.id] });
  ok('every step done: Dispatch', doneState.state === 'dispatch' && doneState.actions.dispatch === true);
  const nothing = await refusal(() => POS.dispatchProductionOrder(conn, c, po12.id));
  ok('a customer\'s production order with nothing in finished stock says so', nothing?.code === 'NOTHING_READY');
  const SOS = await order('SOS', 'confirmed', 'stock');
  const LS = await line(SOS, 1, A, 1);
  await plan(SOS, 'line');
  const RS = await release(SOS, LS, A, 1);
  const PS = await piece(RS, null, A, 0, `${RUN}-SOS-A`);
  await step(PS, 1, { state: 'done', good: 1 });
  const sMade = await POS.createProductionOrders(conn, c, SOS, {});
  const sd = await POS.dispatchProductionOrder(conn, c, sMade.productionOrders[0].id);
  ok('a stock order\'s finished production order closes (its output is on the shelf)', sd.closed === true && sd.productionOrder.state === 'closed');

  // ---- E. the order's time override ----------------------------------------------------------
  section('E. Override all times to N seconds');
  const ov = await POS.setTimeOverride(conn, c, SO1, { seconds: 6 });
  const [[t12]] = await conn.query('SELECT est_setup_minutes AS s, est_work_minutes AS w, est_minutes AS m, quantity AS q FROM cf_production_steps WHERE id = ?', [S12]);
  ok('a done step keeps its time', near(t12.m, 9) && near(t12.w, 2));
  await conn.query("UPDATE cf_production_steps SET state = 'pending', qty_good = 0 WHERE id = ?", [S12]);
  await POS.setTimeOverride(conn, c, SO1, { seconds: 6 });
  const [[t12b]] = await conn.query('SELECT est_setup_minutes AS s, est_work_minutes AS w, est_minutes AS m FROM cf_production_steps WHERE id = ?', [S12]);
  ok('6 s: setup 0.1 min and 0.1 min a piece; 3 pieces → (0.1 + 0.1) × 3 = 0.6 min', ov.timeOverrideSeconds === 6 && near(t12b.s, 0.1) && near(t12b.w, 0.1) && near(t12b.m, 0.6), JSON.stringify(t12b));
  const est = await TIMES.estimatorForLine(conn, COMPANY, L12, [{ bomLineId: null, itemId: B, operationId: OPX }]);
  const cell = est(null, B, OPX);
  ok('the estimator says the order override wins (formula kept beside it)', cell.orderOverride === true && near(cell.work, 0.1) && near(cell.setup, 0.1));
  const grid = await TIMES.getLineTimes(conn, COMPANY, SO1, L12);
  ok('the Times grid carries the override (6 s)', grid.orderOverrideSeconds === 6);
  const view = await POS.getOrderProductionOrders(conn, COMPANY, SO1);
  ok('the order\'s production view carries it', view.order.timeOverrideSeconds === 6);
  const bad = await refusal(() => POS.setTimeOverride(conn, c, SO1, { seconds: -1 }));
  ok('a negative override is refused', bad?.code === 'INVALID');
  const off = await POS.setTimeOverride(conn, c, SO1, { seconds: null });
  const [[t12c]] = await conn.query('SELECT est_work_minutes AS w, est_minutes AS m FROM cf_production_steps WHERE id = ?', [S12]);
  const [[o1]] = await conn.query('SELECT time_override_seconds AS s FROM cf_sales_orders WHERE id = ?', [SO1]);
  // The machine rule: setup 0, work 5 min a piece (its one machine) — 3 pieces → (0 + 5) × 3 = 15 min.
  ok('cleared: the formula again ((0 + 5) × 3 = 15 min), the order\'s column empty', off.timeOverrideSeconds === null && o1.s == null
    && (mc ? near(t12c.w, 5) && near(t12c.m, 15) : t12c.w == null), JSON.stringify(t12c));

  // ---- F. nesting frozen, list / read, fixed reads -----------------------------------------------
  section('F. Nesting frozen; list and read');
  const nl = await NEST.requireLine(conn, COMPANY, L12);
  const frozen = await refusal(async () => NEST.assertOpen(nl));
  ok('nesting refuses a change once the line has a production order', frozen?.code === 'PRODUCTION_ORDER' && /nesting is frozen/.test(frozen.message), frozen?.message);
  const nq = await NEST.requireLine(conn, COMPANY, (await conn.query('SELECT id FROM cf_sales_order_lines WHERE order_id = ?', [SOQ]))[0][0].id);
  ok('a line without one is still open to nesting', (await refusal(async () => NEST.assertOpen(nq))) === null);
  const cnt = counting(conn);
  const list = await POS.listProductionOrders(cnt.db, COMPANY, { search: RUN, state: 'all' });
  ok('the list groups by sales order, every state counted', list.rows.length === 3 && list.counts.all === 4 && list.counts.closed === 1, JSON.stringify(list.counts));
  ok(`the list takes a fixed number of reads (${cnt.tally.n})`, cnt.tally.n <= 4);
  const cnt2 = counting(conn);
  await POS.listProductionOrdersOf(cnt2.db, COMPANY, { orderIds: [SO1, SO2, SOS] });
  ok(`listProductionOrdersOf (the planner's / work orders' read): 3 reads (${cnt2.tally.n})`, cnt2.tally.n === 3);
  // §82 (Maintenance) + the floor: a stop held open by an open maintenance order is not ended by starting work.
  const [[moTable]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cf_maintenance_orders'");
  if (mc && Number(moTable.n)) {
    const [[reason]] = await conn.query('SELECT id FROM cf_stop_reasons WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
    await conn.query('UPDATE cf_machine_stops SET ended_at = started_at WHERE company_id = ? AND machine_id = ? AND ended_at IS NULL', [COMPANY, mc.id]);
    const stopId = await ins("INSERT INTO cf_machine_stops (company_id, machine_id, started_at, reason_id, source) VALUES (?, ?, NOW() - INTERVAL 1 HOUR, ?, 'live')", [COMPANY, mc.id, reason.id]);
    const moId = await ins("INSERT INTO cf_maintenance_orders (company_id, code, machine_id, source, stop_id, reason_id, title, status, raised_at) VALUES (?, ?, ?, 'fault', ?, ?, 'TPO fault', 'open', NOW())",
      [COMPANY, `${RUN}-MO`, mc.id, stopId, reason.id]);
    await conn.query("UPDATE cf_production_steps SET state = 'pending', qty_good = 0, started_at = NULL WHERE id = ?", [S12]);
    const down = await refusal(() => FLOOR.startWork(conn, c, { machineId: mc.id, stepIds: [S12] }));
    ok('floor: a machine down for an open maintenance order does not start work — close the MO first', down?.code === 'MAINTENANCE_OPEN' && /close the maintenance order first/.test(down.message), down?.message);
    const back = await refusal(() => FLOOR.endStop(conn, c, stopId));
    ok('floor: "Back to work" on that stop is refused too', back?.code === 'MAINTENANCE_OPEN');
    await conn.query("UPDATE cf_maintenance_orders SET status = 'done', done_at = NOW() WHERE id = ?", [moId]);
    await FLOOR.endStop(conn, c, stopId);
    const [[ended]] = await conn.query('SELECT ended_at FROM cf_machine_stops WHERE id = ?', [stopId]);
    ok('once the maintenance order is done, the stop ends as before', ended.ended_at != null);
  }
  const one = await POS.readProductionOrder(conn, COMPANY, po12.id);
  ok('read one: its pieces with their steps', one.code === po12.code && one.pieces.length === 1 && one.pieces[0].steps[0].id === S12);
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
