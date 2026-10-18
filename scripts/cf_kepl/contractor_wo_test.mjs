/**
 * contractor_wo_test.mjs — STEP 6 (init.sql §85): CONTRACTOR WORK ORDERS. Local DB only.
 *
 *   cd multi_app_be && node scripts/cf_kepl/contractor_wo_test.mjs
 *   CF_CWO_COMPANY (2)
 *
 *   A. pure: a production order's scope (line / unit / sub-assembly / the rest), its rows, piece paths, lanes
 *   B. the grid: BOM rows × operations of a production order, tonnes = weight × how many it makes, contractors, last rates
 *   C. giving cells: one contractor PO line per operation (tonnes, rate per t, amount), pending Management
 *      ('contractor_po'); refusals (a cell already given, a row with no weight, not a subcontractor, no rate); dry run
 *   D. approval → the work order is ISSUED; sent back → waiting again, send again
 *   E. released steps carry the work order ("with <contractor> (WO-…)"): the tracker, the floor refuses them; the
 *      planner's read (contractorCellsOf)
 *   F. weekly payments: tonnes done → PO line done, part received → closes by itself; amount-only; refusals; removing a
 *      payment puts the tonnes back; lanes Issued → In progress → Completed → Paid in full
 *   G. cost: payments on the order's cost sheet (contractor work); cancel frees the cells; close short asks Management
 *   H. older (§30) work orders stay readable; fixed reads
 *
 * Its own TEST-CWO-… records, INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing it does is re-count every cf_
 * table. Line 923 is never touched.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const CWO = await imp('apps/cf_erp/services/contractorWorkOrderService.js');
const POS = await imp('apps/cf_erp/services/productionOrderService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const FLOOR = await imp('apps/cf_erp/services/floorService.js');
const APP = await imp('apps/cf_erp/services/approvalService.js');
const COST = await imp('apps/cf_erp/services/costingService.js');
const OLD = await imp('apps/cf_erp/services/workOrderService.js');
const PUR = await imp('apps/cf_erp/services/purchaseService.js');
const routes = (await imp('apps/cf_erp/routes/contractorWorkOrders.js')).default;
const oldRoutes = (await imp('apps/cf_erp/routes/workOrders.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_CWO_COMPANY ?? 2);
const RUN = `TEST-CWO-${Date.now().toString(36).toUpperCase()}`;

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
const said = (e, re) => !!e && re.test(`${e.message} ${(e.problems ?? e.extra?.problems ?? []).join(' ')}`);
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
section('A. Pure: scope, rows, piece paths, lanes');
{
  ok('a line / unit production order covers every row', CWO.scopeOf({ level: 'line', scopeKey: 'L5' }).kind === 'all' && CWO.scopeOf({ level: 'unit', scopeKey: 'L5U2' }).perUnit === true);
  const asm = CWO.scopeOf({ level: 'assembly', scopeKey: 'L5U1A10:501/503#2', levelId: 10 });
  ok('a sub-assembly production order names its BOM path', asm.kind === 'assembly' && asm.path === '501/503');
  ok('"the rest" names its level', CWO.scopeOf({ level: 'assembly', scopeKey: 'L5U1R', levelId: 10 }).kind === 'rest');
  const seg = { id: 3, lineId: 503, name: 'Segment', quantity: 2, total: 4, children: [] };
  const girder = { id: 2, lineId: 501, name: 'Girder', quantity: 2, total: 2, children: [seg] };
  const loose = { id: 4, lineId: 502, name: 'Bolt set', quantity: 1, total: 1, children: [] };
  const root = { id: 1, lineId: null, name: 'Span', quantity: 1, total: 1, children: [girder, loose] };
  const all = CWO.rowsOfScope(5, root, { kind: 'all' });
  ok('every row with its path "<line>:<bom line ids>"', all.map((r) => r.path).join(' ') === '5: 5:501 5:501/503 5:502' && all[2].quantity === 4, all.map((r) => `${r.path}=${r.quantity}`).join(' '));
  const one = CWO.rowsOfScope(5, root, { kind: 'assembly', path: '501' });
  ok('a sub-assembly: the row once, its children per one of it', one.length === 2 && one[0].quantity === 1 && one[1].quantity === 2 && one[1].path === '5:501/503');
  const rest = CWO.rowsOfScope(5, root, { kind: 'rest', levelId: 10 }, (id) => (id === 2 ? 10 : null));
  ok('the rest: everything but the sub-assemblies', rest.map((r) => r.path).join(' ') === '5: 5:502');
  const paths = CWO.piecePaths(5, [{ id: 10, depth: 0, parent_id: null }, { id: 11, depth: 1, parent_id: 10, bom_line_id: 501 }, { id: 12, depth: 2, parent_id: 11, bom_line_id: 503 }]);
  ok('a released piece has the same path as its row', paths.get(10) === '5:' && paths.get(12) === '5:501/503');
  const po = (status, extra = {}) => ({ status, approval_status: null, closed_at: null, ...extra });
  ok('lanes: waiting approval → issued → in progress → completed → paid',
    CWO.laneOf({ status: 'draft' }, po('requested', { approval_status: 'pending' }), 0, 0) === 'waiting_approval'
    && CWO.laneOf({ status: 'issued' }, po('ordered'), 0, 0) === 'issued'
    && CWO.laneOf({ status: 'issued' }, po('partially_received'), 1, 100, 100) === 'in_progress'
    && CWO.laneOf({ status: 'issued' }, po('received'), 2, 100, 200) === 'completed'
    && CWO.laneOf({ status: 'issued' }, po('received'), 2, 200, 200) === 'paid'
    && CWO.laneOf({ status: 'issued' }, po('cancelled'), 0, 0) === 'cancelled');
}
const routeList = routes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
ok('routes: grid, give, lanes, one, payments, remove, close short, cancel, send again, planner cells',
  ['get /production-orders/:id/contractor-grid', 'post /production-orders/:id/contractor-work-orders', 'get /accounts/work-orders', 'get /accounts/work-orders/:id',
    'post /accounts/work-orders/:id/payments', 'delete /accounts/work-order-payments/:id', 'post /accounts/work-orders/:id/close-short',
    'post /accounts/work-orders/:id/cancel', 'post /accounts/work-orders/:id/send-again', 'get /contractor-work/cells'].every((r) => routeList.includes(r)), routeList.join(', '));
const oldList = oldRoutes.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
ok('the older work orders stay readable (GET /work-orders, /work-orders/:id)', oldList.includes('get /work-orders') && oldList.includes('get /work-orders/:id'));

const conn = await pool.getConnection();
let exitCode = 0;
let before = null;
try {
  before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const boss = { can: () => true, isAdmin: true };
  const ins = async (sql, args) => (await conn.query(sql, args))[0].insertId;
  console.log(`\nCompany ${COMPANY} — run ${RUN}`);

  // ---- fixture ---------------------------------------------------------------------
  // Span (the line's item, qty 2) = 2 × Girder (500 kg) + 4 × Plate (250 kg); flow Cut → Weld on each row.
  const [[node]] = await conn.query("SELECT id FROM cf_classification_nodes WHERE company_id = ? AND scope IN ('item','both') AND deleted_at IS NULL ORDER BY depth DESC, id LIMIT 1", [COMPANY]);
  const [[weightSpec]] = await conn.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const OPC = await ins("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, ?, 'active')", [COMPANY, `${RUN}-CUT`, `${RUN} Cut`]);
  const OPW = await ins("INSERT INTO cf_operations (company_id, code, name, status) VALUES (?, ?, ?, 'active')", [COMPANY, `${RUN}-WELD`, `${RUN} Weld`]);
  const FLOW = await ins("INSERT INTO cf_operation_flows (company_id, code, name, status) VALUES (?, ?, ?, 'active')", [COMPANY, `${RUN}-F`, `${RUN} flow`]);
  await conn.query('INSERT INTO cf_operation_flow_steps (company_id, flow_id, sequence, operation_id) VALUES (?, ?, 10, ?), (?, ?, 20, ?)', [COMPANY, FLOW, OPC, COMPANY, FLOW, OPW]);
  const master = async (key, kg) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status, default_flow_id) VALUES (?, 'item', ?, ?, ?, 'active', ?)", [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, node.id, FLOW]);
    await conn.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'make')", [id, COMPANY]);
    if (kg != null && weightSpec) await conn.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom) VALUES (?, ?, 'master', ?, ?, 'kg')", [COMPANY, weightSpec.id, id, kg]);
    return id;
  };
  const SPAN = await master('SPAN', null);
  const GIRDER = await master('GIRDER', 500);
  const PLATE = await master('PLATE', 250);
  const BOM = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, 'standard', 'active')", [COMPANY, SPAN]);
  const BL_G = await ins('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, 10, ?, ?, 1, 2)', [COMPANY, BOM, GIRDER, GIRDER]);
  const BL_P = await ins('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, 20, ?, ?, 2, 4)', [COMPANY, BOM, PLATE, PLATE]);
  const CUST = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-CUST`, `${RUN} customer`]);
  const CON = await ins("INSERT INTO cf_parties (company_id, code, name, is_subcontractor, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-CON`, `${RUN} Welders`]);
  const CON2 = await ins("INSERT INTO cf_parties (company_id, code, name, is_subcontractor, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-CON2`, `${RUN} Cutters`]);
  const SUP = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${RUN}-SUP`, `${RUN} supplier`]);
  const SO = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, customer_id) VALUES (?, ?, 'customer', 'CWO test', 'confirmed', ?)", [COMPANY, `${RUN}-SO`, CUST]);
  const LINE = await ins("INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity) VALUES (?, ?, 1, 'standard', ?, ?, 1, 2)", [COMPANY, SO, SPAN, SPAN]);
  await conn.query("INSERT INTO cf_order_execution_plans (company_id, order_id, order_line_id, production_level, dispatch_level) VALUES (?, ?, NULL, 'line', 'same')", [COMPANY, SO]);
  const made = await POS.createProductionOrders(conn, c, SO, {});
  const PO = made.productionOrders[0];
  ok('fixture: one production order for the line', made.created === 1 && !!PO);
  const keyG = `${LINE}:${BL_G}`;
  const keyP = `${LINE}:${BL_P}`;

  // ---- B. the grid -------------------------------------------------------------------------
  section('B. The grid: BOM rows × operations');
  const cnt = counting(conn);
  const grid = await CWO.contractorGrid(cnt.db, COMPANY, PO.id);
  ok(`the grid takes a fixed handful of reads (${cnt.tally.n})`, cnt.tally.n <= 16);
  ok('rows: the span, its girders and plates', grid.rows.length === 3 && grid.rows.map((r) => r.key).join(',') === `${LINE}:,${keyG},${keyP}`, grid.rows.map((r) => r.key).join(','));
  const rG = grid.rows.find((r) => r.key === keyG);
  const rP = grid.rows.find((r) => r.key === keyP);
  ok('quantities for the production order: 2 spans → 4 girders, 8 plates', rG.quantity === 4 && rP.quantity === 8);
  ok('tonnes = weight × how many: girders 4 × 500 kg = 2 t, plates 8 × 250 kg = 2 t', near(rG.tonnes, 2) && near(rP.tonnes, 2));
  ok('the span has no weight: its tonnes are unknown', grid.rows[0].tonnes === null);
  ok('columns: Cut then Weld (flow order)', grid.operations.map((o) => o.id).join(',') === `${OPC},${OPW}`);
  ok('every cell free and editable to start', Object.values(rG.cells).every((x) => x.editable && !x.workOrder));
  ok('contractors = parties with the subcontractor role', grid.contractors.some((x) => x.id === CON) && !grid.contractors.some((x) => x.id === SUP));

  // ---- C. giving cells ---------------------------------------------------------------------
  section('C. Give cells to a contractor → a contractor PO');
  const cells = [{ rowKey: keyG, operationId: OPW }, { rowKey: keyP, operationId: OPW }, { rowKey: keyG, operationId: OPC }];
  const dry = await CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: CON, cells, rates: { [OPW]: 4000, [OPC]: 1500 }, dryRun: true });
  ok('dry run: Weld 4 t × 4000 = 16,000; Cut 2 t × 1500 = 3,000; total 19,000', dry.lines.length === 2 && near(dry.lines.find((l) => l.operation.id === OPW).tonnes, 4)
    && dry.amount === 19000 && dry.problems.length === 0, JSON.stringify(dry.lines.map((l) => [l.operation.id, l.tonnes, l.amount])));
  const [[{ n: poBefore }]] = await conn.query('SELECT COUNT(*) AS n FROM cf_purchase_orders WHERE company_id = ?', [COMPANY]);
  const [[{ n: poAfterDry }]] = await conn.query('SELECT COUNT(*) AS n FROM cf_purchase_orders WHERE company_id = ?', [COMPANY]);
  ok('a dry run writes nothing', poBefore === poAfterDry);
  const noRate = await refusal(() => CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: CON, cells, rates: { [OPW]: 4000 } }));
  ok('refused without a rate for every operation', said(noRate, /Cut: give the rate per tonne/), noRate?.message);
  const notCon = await refusal(() => CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: SUP, cells, rates: { [OPW]: 1, [OPC]: 1 } }));
  ok('refused for a party that is not a subcontractor', said(notCon, /not a subcontractor/), notCon?.message);
  const noWeight = await refusal(() => CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: CON, cells: [{ rowKey: `${LINE}:`, operationId: OPW }], rates: { [OPW]: 1 } }));
  ok('refused for a row with no weight (its tonnes are unknown)', said(noWeight, /no weight yet/), noWeight?.message);
  const cntW = counting(conn);
  const wo = await CWO.createContractorWorkOrder(cntW.db, c, PO.id, { contractorId: CON, cells, rates: { [OPW]: 4000, [OPC]: 1500 }, dueDate: '2026-12-31', notes: 'week 1' });
  ok(`made in a fixed number of round trips (${cntW.tally.n})`, cntW.tally.n <= 48);
  ok('a work order, waiting for Management approval', wo.kind === 'po' && wo.lane === 'waiting_approval' && wo.status === 'draft' && /^WO-|./.test(wo.code));
  const [[cpo]] = await conn.query('SELECT * FROM cf_purchase_orders WHERE id = ?', [wo.purchaseOrder.id]);
  ok('a CONTRACTOR PO to the contractor, pending approval, for the sales order', cpo.po_type === 'contractor' && cpo.approval_status === 'pending' && cpo.supplier_id === CON && cpo.for_order_id === SO);
  const [pl] = await conn.query('SELECT l.*, m.code AS item_code FROM cf_purchase_order_lines l JOIN cf_master_records m ON m.id = l.item_id WHERE l.purchase_order_id = ? ORDER BY l.line_no', [cpo.id]);
  ok('one PO line per operation, quantity in tonnes, rate per tonne', pl.length === 2 && pl.every((l) => l.uom === 't') && pl.some((l) => near(l.quantity, 4) && near(l.unit_price, 4000)) && pl.some((l) => near(l.quantity, 2) && near(l.unit_price, 1500)));
  ok('the PO lines are the operations\' contractor services (CW-<operation>)', pl.every((l) => /^CW-/.test(l.item_code)));
  ok('the work order lists its lines and its cells', wo.lines.length === 2 && wo.scope.length === 3 && near(wo.tonnes, 6) && wo.value === 19000);
  const [[appr]] = await conn.query("SELECT * FROM cf_approvals WHERE company_id = ? AND approval_type = 'contractor_po' AND subject_id = ? AND status = 'pending'", [COMPANY, cpo.id]);
  ok('a Management inbox row of type contractor_po', !!appr);
  const ctxRows = await APP.listApprovals(conn, COMPANY, () => true, { status: 'pending', type: 'contractor_po' });
  const mine = (ctxRows.rows ?? ctxRows).find?.((r) => r.id === appr?.id);
  ok('the inbox shows the PO and the work order it is for', !!mine && mine.context?.workOrder?.code === wo.code, JSON.stringify(mine?.context?.workOrder));
  const g2 = await CWO.contractorGrid(conn, COMPANY, PO.id);
  const cellG = g2.rows.find((r) => r.key === keyG).cells[OPW];
  ok('the grid says "with <contractor> (WO-…)" on a given cell', cellG.workOrder?.code === wo.code && !cellG.editable && /With .*Welders/.test(cellG.why));
  ok('the grid lists the work order', g2.workOrders.some((x) => x.id === wo.id && x.cells === 3));
  ok('the contractor\'s last rate is the prefill', g2.lastRates[CON]?.[OPW] === 4000 && g2.lastRates[CON]?.[OPC] === 1500);
  const twice = await refusal(() => CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: CON2, cells: [{ rowKey: keyG, operationId: OPW }], rates: { [OPW]: 1 } }));
  ok('a cell already given is refused, naming who has it', said(twice, /already with .*Welders/), twice?.message);

  // ---- D. approval -------------------------------------------------------------------------
  section('D. Management approval issues the work order');
  // A second one, sent back first.
  const wo2 = await CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: CON2, cells: [{ rowKey: keyP, operationId: OPC }], rates: { [OPC]: 1200 } });
  const [[a2]] = await conn.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'contractor_po' AND subject_id = ? AND status = 'pending'", [COMPANY, wo2.purchaseOrder.id]);
  await APP.decide(conn, c, a2.id, { decision: 'reject', note: 'Rate too high' }, boss);
  const back = await CWO.readContractorWorkOrder(conn, COMPANY, wo2.id);
  ok('sent back: still waiting, with the reason, "send again" offered', back.lane === 'waiting_approval' && /Rate too high/.test(back.sentBack ?? '') && back.actions.sendAgain === true);
  const again = await CWO.sendAgain(conn, c, wo2.id);
  ok('sent again: pending Management once more', again.purchaseOrder.stage === 'pending_approval' && !again.sentBack);
  await APP.decide(conn, c, appr.id, { decision: 'approve' }, boss);
  const issued = await CWO.readContractorWorkOrder(conn, COMPANY, wo.id);
  ok('approved: the work order is ISSUED (PO waiting)', issued.lane === 'issued' && issued.status === 'issued' && issued.startDate != null && issued.purchaseOrder.stage === 'waiting');

  // ---- E. released steps -----------------------------------------------------------------------
  section('E. Released steps carry the work order');
  // The tracker of the line as the release engine would write it: span ×2, each 2 girders and 4 plates; steps Cut / Weld.
  const REL1 = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 2)', [COMPANY, SO, LINE, SPAN]);
  let sort = 0;
  const piece = (parent, item, depth, bl, qty) => ins(
    'INSERT INTO cf_production_items (company_id, release_id, parent_id, item_id, bom_line_id, quantity, piece_no, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
    [COMPANY, REL1, parent, item, bl, qty, `${RUN}-P${sort + 1}`, FLOW, depth, ++sort]);
  const step = (itemId, op, qty) => ins(
    "INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, quantity, state) VALUES (?, ?, ?, ?, ?, 'pending')",
    [COMPANY, itemId, op, op === OPC ? 10 : 20, qty]);
  const P0 = await piece(null, SPAN, 0, null, 2);
  const PG = await piece(P0, GIRDER, 1, BL_G, 4);
  const PP = await piece(P0, PLATE, 1, BL_P, 8);
  const S = { g: { c: await step(PG, OPC, 4), w: await step(PG, OPW, 4) }, p: { c: await step(PP, OPC, 8), w: await step(PP, OPW, 8) }, root: await step(P0, OPW, 2) };
  await conn.query("UPDATE cf_production_orders SET status = 'planned', released_at = NOW() WHERE id = ?", [PO.id]);
  await POS.stampLines(conn, c, [LINE]);
  const [stamped] = await conn.query('SELECT id, work_order_id FROM cf_production_steps WHERE id IN (?)', [[S.g.c, S.g.w, S.p.c, S.p.w, S.root]]);
  const woOf = (id) => stamped.find((x) => x.id === id)?.work_order_id ?? null;
  ok('release stamps each given cell\'s step with its work order', woOf(S.g.w) === wo.id && woOf(S.p.w) === wo.id && woOf(S.g.c) === wo.id && woOf(S.p.c) === wo2.id);
  ok('a cell not given stays in-house', woOf(S.root) === null);
  const tr = await REL.listTrackerSteps(conn, COMPANY, { productionOrderId: PO.id, search: RUN });
  const trW = tr.find((s) => s.id === S.g.w);
  ok('the tracker shows the step "with <contractor> (WO-…)"', trW?.workOrder?.code === wo.code && /Welders/.test(trW?.workOrder?.contractorName ?? ''), JSON.stringify(trW?.workOrder));
  const [mc] = (await conn.query("SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1", [COMPANY]))[0];
  if (mc) {
    const floorNo = await refusal(() => FLOOR.startWork(conn, c, { machineId: mc.id, stepIds: [S.g.w] }));
    ok('the floor does not start a step that is with a contractor', !!floorNo && /contractor work order/.test(JSON.stringify(floorNo.problems ?? floorNo.message)), floorNo?.message);
  }
  const cellsRead = await CWO.contractorCellsOf(conn, COMPANY, { productionOrderIds: String(PO.id) });
  ok('the planner\'s read: 4 cells under open work orders, with the contractor and the released steps',
    cellsRead.cells.length === 4 && cellsRead.cells.every((x) => /^with .* \(.+\)$/.test(x.text)) && (cellsRead.stepIds[wo.id] ?? []).length === 3, JSON.stringify(cellsRead.cells.map((x) => x.text)));
  const g3 = await CWO.contractorGrid(conn, COMPANY, PO.id);
  ok('released: the grid still knows the cells', g3.rows.find((r) => r.key === keyP).cells[OPC].workOrder?.id === wo2.id);

  // ---- F. weekly payments -------------------------------------------------------------------
  section('F. Weekly payments');
  const lw = issued.lines.find((l) => l.operation.id === OPW);
  const lc = issued.lines.find((l) => l.operation.id === OPC);
  const dryPay = await CWO.recordPayment(conn, c, wo.id, { dryRun: true, lines: [{ poLineId: lw.id, tonnes: 1.5 }] });
  ok('dry run: 1.5 t × 4000 = 6,000', dryPay.amount === 6000 && dryPay.problems.length === 0);
  const over = await refusal(() => CWO.recordPayment(conn, c, wo.id, { lines: [{ poLineId: lw.id, tonnes: 5 }] }));
  ok('more tonnes than are left is refused', said(over, /only 4 t is still to do/), over?.message);
  const future = await refusal(() => CWO.recordPayment(conn, c, wo.id, { paymentDate: '2099-01-01', lines: [{ poLineId: lw.id, tonnes: 1 }] }));
  ok('a payment dated in the future is refused', said(future, /in the future/));
  const empty = await refusal(() => CWO.recordPayment(conn, c, wo.id, { lines: [{ poLineId: lw.id }] }));
  ok('nothing entered is refused', said(empty, /at least one operation/));
  const cntP = counting(conn);
  const p1 = await CWO.recordPayment(cntP.db, c, wo.id, { reference: 'NEFT-1', lines: [{ poLineId: lw.id, tonnes: 1.5 }] });
  ok(`week 1: 1.5 t welded paid 6,000 — In progress (${cntP.tally.n} round trips)`, p1.workOrder.lane === 'in_progress' && near(p1.workOrder.done, 1.5) && p1.workOrder.paid === 6000 && p1.workOrder.status === 'in_progress');
  const [[po1]] = await conn.query('SELECT status FROM cf_purchase_orders WHERE id = ?', [cpo.id]);
  const [[ln1]] = await conn.query('SELECT qty_received FROM cf_purchase_order_lines WHERE id = ?', [lw.id]);
  ok('the PO moves like a GRN: line done 1.5 t, part received', po1.status === 'partially_received' && near(ln1.qty_received, 1.5));
  // Week 2: the rest, the weld paid at a lower amount (a deduction) → Completed, not paid in full.
  const p2 = await CWO.recordPayment(conn, c, wo.id, { reference: 'NEFT-2', lines: [{ poLineId: lw.id, tonnes: 2.5, amount: 9000 }, { poLineId: lc.id, tonnes: 2 }] });
  const [[po2]] = await conn.query('SELECT status, closed_at FROM cf_purchase_orders WHERE id = ?', [cpo.id]);
  ok('all done → the PO closes by itself', po2.status === 'received' && po2.closed_at == null);
  ok('done but ₹1,000 still owed → Completed', p2.workOrder.lane === 'completed' && p2.workOrder.owed === 1000 && p2.closed === true, `${p2.workOrder.lane} ${p2.workOrder.owed}`);
  const tonnesNow = await refusal(() => CWO.recordPayment(conn, c, wo.id, { lines: [{ poLineId: lw.id, tonnes: 0.1 }] }));
  ok('complete: no more tonnes, an amount only', said(tonnesNow, /record an amount only/));
  const p3 = await CWO.recordPayment(conn, c, wo.id, { reference: 'NEFT-3', lines: [{ poLineId: lw.id, amount: 1000 }] });
  ok('the balance paid → Paid in full', p3.workOrder.lane === 'paid' && p3.workOrder.owed === 0 && p3.workOrder.paid === 19000);
  const board = await CWO.workOrderBoard(conn, COMPANY, { search: RUN });
  ok('the board: lanes Waiting approval → Issued → In progress → Completed → Paid in full', board.lanes.map((l) => l.key).join(',') === 'waiting_approval,issued,in_progress,completed,paid');
  ok('the board places both work orders', board.lanes.find((l) => l.key === 'paid').cards.some((x) => x.id === wo.id) && board.lanes.find((l) => l.key === 'waiting_approval').cards.some((x) => x.id === wo2.id));
  const cntB = counting(conn);
  await CWO.workOrderBoard(cntB.db, COMPANY, {});
  ok(`the board takes one read (${cntB.tally.n})`, cntB.tally.n <= 2);
  const removed = await CWO.removePayment(conn, c, p2.payment.id, { reason: 'Entered twice' });
  const [[po3]] = await conn.query('SELECT status FROM cf_purchase_orders WHERE id = ?', [cpo.id]);
  ok('removing a payment puts its tonnes back and re-opens the PO', po3.status === 'partially_received' && near(removed.done, 1.5) && removed.lane === 'in_progress' && removed.payments.find((x) => x.id === p2.payment.id)?.removed?.reason === 'Entered twice');
  const noReason = await refusal(() => CWO.removePayment(conn, c, p1.payment.id, {}));
  ok('removing needs a reason', said(noReason, /Say why/));

  // ---- G. cost, cancel, close short ------------------------------------------------------------
  section('G. Cost sheet; cancel; close short');
  const costs = await CWO.contractorCostOf(conn, COMPANY, [SO]);
  ok('contractor cost of the order = what was paid (6,000 + 1,000)', costs.get(SO).paid === 7000 && costs.get(SO).committed === 19000 + 2400, JSON.stringify(costs.get(SO)));
  const sheet = await COST.costSheet(conn, COMPANY, SO);
  ok('the order\'s cost sheet carries it as contractor work', sheet.contractor === 7000 && near(sheet.margin, -7000 - sheet.material - sheet.consumables + sheet.credits + sheet.charged, 0.01), `${sheet.contractor} ${sheet.margin}`);
  // wo2 (still pending): cancel it — the cells free, the plates' Cut step back in-house.
  const cancelled = await CWO.cancelContractorWorkOrder(conn, c, wo2.id, { reason: 'Doing it ourselves' });
  const [[sp]] = await conn.query('SELECT work_order_id FROM cf_production_steps WHERE id = ?', [S.p.c]);
  const g4 = await CWO.contractorGrid(conn, COMPANY, PO.id);
  ok('cancelled: PO cancelled, the cell free again, its step in-house', cancelled.lane === 'cancelled' && sp.work_order_id == null && g4.rows.find((r) => r.key === keyP).cells[OPC].editable === true);
  const cantCancel = await refusal(() => CWO.cancelContractorWorkOrder(conn, c, wo.id, { reason: 'x' }));
  ok('a work order with work done is not cancelled — close it short', said(cantCancel, /close it short/));
  // A third, issued, closed short.
  const wo3 = await CWO.createContractorWorkOrder(conn, c, PO.id, { contractorId: CON2, cells: [{ rowKey: keyP, operationId: OPC }], rates: { [OPC]: 1000 } });
  const [[a3]] = await conn.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'contractor_po' AND subject_id = ? AND status = 'pending'", [COMPANY, wo3.purchaseOrder.id]);
  await APP.decide(conn, c, a3.id, { decision: 'approve' }, boss);
  const l3 = (await CWO.readContractorWorkOrder(conn, COMPANY, wo3.id)).lines[0];
  await CWO.recordPayment(conn, c, wo3.id, { lines: [{ poLineId: l3.id, tonnes: 0.5 }] });
  const asked = await CWO.askCloseShort(conn, c, wo3.id, { reason: 'Contractor left' });
  ok('close short asks Management (the PO\'s close-short approval)', asked.pendingApprovals.some((a) => a.type === 'po_close_short') && asked.actions.closeShort === false);
  const [[a4]] = await conn.query("SELECT id FROM cf_approvals WHERE company_id = ? AND approval_type = 'po_close_short' AND subject_id = ? AND status = 'pending'", [COMPANY, wo3.purchaseOrder.id]);
  await APP.decide(conn, c, a4.id, { decision: 'approve' }, boss);
  const short = await CWO.readContractorWorkOrder(conn, COMPANY, wo3.id);
  ok('closed short and paid for what was done → Paid in full', short.purchaseOrder.stage === 'closed_short' && short.lane === 'paid' && short.pending === 0);

  // ---- H. older work orders ---------------------------------------------------------------------
  section('H. Older (§30) work orders stay readable');
  const OLDWO = await ins("INSERT INTO cf_work_orders (company_id, code, order_id, order_line_id, contractor_id, status) VALUES (?, ?, ?, ?, ?, 'issued')", [COMPANY, `${RUN}-OLD`, SO, LINE, CON]);
  const oldRead = await OLD.getWorkOrder(conn, COMPANY, OLDWO);
  ok('an older work order reads as before', oldRead.code === `${RUN}-OLD` && oldRead.status === 'issued');
  const oldList2 = await OLD.listWorkOrders(conn, COMPANY, { search: RUN });
  ok('the older list still lists it', oldList2.some((x) => x.id === OLDWO));
  const asNew = await CWO.readContractorWorkOrder(conn, COMPANY, OLDWO);
  ok('read through Accounts it is the older kind, read-only', asNew.kind === 'cells' && Object.keys(asNew.actions).length === 0);
  const notOnBoard = await CWO.workOrderBoard(conn, COMPANY, { search: RUN });
  ok('the Accounts board shows only contractor-PO work orders', !notOnBoard.lanes.some((l) => l.cards.some((x) => x.id === OLDWO)));
  const oldPay = await refusal(() => CWO.recordPayment(conn, c, OLDWO, { lines: [] }));
  ok('an older work order takes no payments here', oldPay?.code === 'OLD_WORK_ORDER');
  const contractorPos = await PUR.listPurchaseOrders(conn, COMPANY, { type: 'contractor', status: 'all', search: RUN });
  ok('the contractor POs list in Purchase as type Contractor', (contractorPos.rows ?? contractorPos).filter((p) => p.type === 'contractor').length >= 3);
  const pend = await PUR.pendingLines(conn, COMPANY, { search: RUN });
  ok('Receive against PO leaves contractor POs out (they move by payments)', !pend.rows.some((r) => r.purchaseOrder.type === 'contractor'));
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
