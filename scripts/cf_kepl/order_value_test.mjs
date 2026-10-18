/**
 * order_value_test.mjs — ONE ORDER VALUE (2026-10-18; services/orderValueService.js; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — One order value; scrap & offcuts; GST gaps"). The SO260014 walkthrough showed "Order value ₹6,91,46,903"
 * (line qty × the rate typed at Add line) beside an acceptance of ₹38,72,227.
 *
 *   cd multi_app_be && node scripts/cf_kepl/order_value_test.mjs        CF_VALUE_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-OVAL-<run>).
 *
 *   1  the rule, pure: no terms → the estimate (labelled); pending terms → "awaiting approval"; approved → "accepted";
 *      a pending rate change does not move the approved value; differs only when ≥ ₹1 apart; nothing priced → none
 *   2  an inquiry priced at Add line (₹25 lakh a tonne): header, Orders list, Orders board all say "estimate"
 *   3  terms sent (pending): every screen shows the terms' value, "awaiting approval · estimate ₹…"
 *   4  approved: "accepted"; the dashboard's order book uses it too; the line rates are NOT rewritten
 *   5  a rate change waiting: the approved value stays, the pending one is said beside it
 *   6  terms sent back (rejected) on another order: the estimate stands again
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const OV = await imp('apps/cf_erp/services/orderValueService.js');
const ACC = await imp('apps/cf_erp/services/acceptanceService.js');
const AP = await imp('apps/cf_erp/services/approvalService.js');
const BOARD = await imp('apps/cf_erp/services/orderBoardService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const D = await imp('apps/cf_erp/services/dashboardService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const BILL = await imp('apps/cf_erp/services/billingService.js');
const { harness, girder, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_VALUE_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-OVAL-${RUN}`;
const H = harness(pool);
const { ok, section, j } = H;
const near = (a, b, tol = 0.011) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const before = await H.counts();
const db = await pool.getConnection();
const all = () => true;
const T = BILL.todayText();

try {
  /* ════════════════════ 1. the rule, pure ════════════════════ */
  section('1. The rule (pure)');
  const est = { amount: 6914690.3, complete: true, unpricedLines: [] };
  let v = OV.orderValueOf(est, null, { lineCount: 1 });
  ok('no terms → the estimate from the line rates, labelled "estimate"', v.basis === 'estimate' && near(v.amount, 6914690.3) && v.label === 'estimate' && !v.differs, j(v));
  v = OV.orderValueOf({ ...est, complete: false, unpricedLines: [2] }, null, { lineCount: 2 });
  ok('a part-priced estimate says so', v.basis === 'estimate' && /not every line/.test(v.label));
  v = OV.orderValueOf({ amount: 0, complete: false, unpricedLines: [1] }, null, { lineCount: 1 });
  ok('nothing priced, no terms → no value ("not priced")', v.basis === 'none' && v.amount == null && v.label === 'not priced');
  v = OV.orderValueOf(est, { approved: null, pending: { value: 387222.7, version: 1 } }, { lineCount: 1 });
  ok('terms sent → their value, "terms awaiting approval", differs from the estimate', v.basis === 'awaiting_approval' && near(v.amount, 387222.7) && v.differs && near(v.estimate, 6914690.3), j(v));
  v = OV.orderValueOf(est, { approved: { value: 3872227, version: 1 }, pending: { value: 4000000, version: 2 } }, { lineCount: 1 });
  ok('approved → "accepted"; a rate change waiting does not move it (said as pendingValue)', v.basis === 'accepted' && v.amount === 3872227 && v.pendingValue === 4000000 && v.accepted === 3872227, j(v));
  v = OV.orderValueOf({ amount: 3872227.4, complete: true, unpricedLines: [] }, { approved: { value: 3872227, version: 1 }, pending: null }, { lineCount: 1 });
  ok('within ₹1 of the estimate → not "differs"', v.basis === 'accepted' && v.differs === false);
  v = OV.orderValueOf({ amount: 0, complete: false, unpricedLines: [1] }, { approved: { value: 500000, version: 1 }, pending: null }, { lineCount: 1 });
  ok('accepted with no line rates at all → the accepted value, no estimate', v.amount === 500000 && v.estimate == null && v.differs === false);

  await db.beginTransaction();
  attachNodeCache(db);
  const [users] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY]);
  if (users.length < 2) throw new Error('The suite needs two users in the company.');
  const c = { companyId: COMPANY, userId: users[0].id };
  const md = { companyId: COMPANY, userId: users[1].id };
  const asMd = { can: all, isAdmin: false };
  await quietCodes(db, COMPANY, ['purchase_order', 'sales_order', 'stock_movement', 'tax_invoice']);

  // ── fixture: a girder at 2 000 kg, an acceptance process, a fabrication operation ──
  const G = await girder(db, c, tag);
  const fab = await OPS.createOperation(db, c, { code: `${tag}-FAB`, name: `Fabrication ${tag}` });
  const [[weightSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const prc = await PROC.createProcess(db, c, { code: `${tag}-PRC`, name: `Order value test ${tag}` });
  await PROC.replaceStages(db, c, prc.id, { stages: ['structure', 'lock', 'nesting', 'buying', 'acceptance', 'production'].map((stageKey) => ({ stageKey })) });
  await PROC.setProcessStatus(db, c, prc.id, 'active');
  const makeOrder = async (key, qty, rate) => {
    const o = await G.girderOrder(key, qty, { status: 'inquiry', lock: true });
    await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, o.id]);
    const [[line]] = await db.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [o.lineId]);
    await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, 2000, 'kg', 'entered')
                    ON DUPLICATE KEY UPDATE value_number = 2000, uom = 'kg'`, [COMPANY, weightSpec.id, line.item_id]);
    // The rate typed at Add line: ₹25 lakh per tonne (the walkthrough's).
    await db.query("UPDATE cf_sales_order_lines SET rate = ?, rate_basis = 'tonne' WHERE id = ?", [rate, o.lineId]);
    return o;
  };
  const terms = (fabRate) => ({
    charges: [{ key: 'fab', label: 'Fabrication', operationId: fab.id, basis: { type: 'weight', weight: 'drawing' }, rate: fabRate, billing: 'pro_rata' }],
    material: { rate: 70000, weight: 'drawing' },
    lumpSums: [{ key: 'tr', label: 'Transport', amount: 50000 }],
    milestones: [{ key: 'm1', label: 'Advance', kind: 'percent', value: 100, trigger: { type: 'order_accepted' }, creditDays: 0 }],
    stages: [],
  });
  const screens = async (o) => {
    const order = await SO.getOrder(db, COMPANY, o.id);
    const list = await SO.listOrders(db, COMPANY, { search: tag, revisions: 'all' });
    const board = await BOARD.orderBoard(db, COMPANY, { search: tag });
    return { header: order.value, order, list: list.find((x) => x.id === o.id)?.value, board: board.lanes.flatMap((l) => l.cards).find((x) => x.id === o.id)?.value };
  };

  /* ════════════════════ 2. an inquiry priced at Add line ════════════════════ */
  section('2. Before acceptance — the estimate from the line rates');
  const A = await makeOrder('A', 2, 2500000);
  let s = await screens(A);
  ok('header: the estimate, 4 t × ₹25 lakh = ₹1 crore, labelled "estimate"', s.header?.basis === 'estimate' && near(s.header.amount, 10000000) && s.header.label === 'estimate', j(s.header));
  ok('the header keeps the line total (GST estimate) beside it', near(s.order.total.amount, 10000000));
  ok('the Orders list says the same', s.list?.basis === 'estimate' && near(s.list.amount, 10000000), j(s.list));
  ok('the Orders board card says the same', s.board?.basis === 'estimate' && near(s.board.amount, 10000000), j(s.board));

  /* ════════════════════ 3. terms sent ════════════════════ */
  section('3. Terms sent — every screen shows them, awaiting approval');
  await RQ.raiseRequisitions(db, c, A.id, { earmark: true });
  const saved = await ACC.saveAcceptance(db, c, A.id, terms(45000));
  const V = saved.pending.estimate.value;
  ok('the terms come to 4 t × 45,000 + 4 t × 70,000 + 50,000 = ₹5,10,000', near(V, 510000), j(V));
  s = await screens(A);
  ok('header: ₹5,10,000 "terms awaiting approval", estimate ₹1 crore beside it', s.header?.basis === 'awaiting_approval' && near(s.header.amount, V) && s.header.differs && near(s.header.estimate, 10000000), j(s.header));
  ok('list and board agree', s.list?.basis === 'awaiting_approval' && near(s.list.amount, V) && s.board?.basis === 'awaiting_approval' && near(s.board.amount, V));
  const view = await ACC.getAcceptance(db, COMPANY, A.id);
  ok('the acceptance step carries the order value and the line estimate (to say they differ)', view.orderValue?.basis === 'awaiting_approval' && near(view.orderValue.estimate, 10000000));

  /* ════════════════════ 4. approved ════════════════════ */
  section('4. Approved — "accepted" everywhere; the line rates untouched');
  await AP.decide(db, md, saved.pending.approvalId, { decision: 'approve' }, asMd);
  s = await screens(A);
  ok('header: ₹5,10,000 accepted · estimate ₹1 crore', s.header?.basis === 'accepted' && near(s.header.amount, V) && near(s.header.accepted, V) && s.header.differs, j(s.header));
  ok('list and board: accepted', s.list?.basis === 'accepted' && near(s.list.amount, V) && s.board?.basis === 'accepted' && near(s.board.amount, V));
  const [[lineNow]] = await db.query('SELECT rate, rate_basis FROM cf_sales_order_lines WHERE id = ?', [A.lineId]);
  ok('the line rate is NOT rewritten from the acceptance (it stays the sales estimate)', Number(lineNow.rate) === 2500000 && lineNow.rate_basis === 'tonne');
  const dash = await D.ordersDashboard(db, COMPANY, {}, { withMoney: true });
  const dA = dash.orders.find((o) => o.id === A.id);
  ok('the dashboard order book uses the accepted value', dA?.money && near(dA.money.value, V) && dA.money.valueBasis === 'accepted' && near(dA.money.estimate, 10000000), j(dA?.money));
  const fromScratch = (await OV.orderValuesFor(db, COMPANY, [A.id])).get(A.id);
  ok('orderValuesFor (board, step) agrees with the header', fromScratch.basis === 'accepted' && near(fromScratch.amount, V) && near(fromScratch.estimate, 10000000));

  /* ════════════════════ 5. a rate change waiting ════════════════════ */
  section('5. A rate change waiting — the approved value stays');
  const rc = await ACC.saveAcceptance(db, c, A.id, terms(50000));
  ok('the rate change is pending', rc.pending?.kind === 'rate_change');
  s = await screens(A);
  ok('header: still the approved ₹5,10,000; the waiting ₹5,30,000 said beside it', s.header?.basis === 'accepted' && near(s.header.amount, V) && near(s.header.pendingValue, 530000), j(s.header));

  /* ════════════════════ 6. terms sent back ════════════════════ */
  section('6. Terms sent back — the estimate stands again');
  const Bo = await makeOrder('B', 1, 2500000);
  await RQ.raiseRequisitions(db, c, Bo.id, { earmark: true });
  const sb = await ACC.saveAcceptance(db, c, Bo.id, terms(45000));
  s = await screens(Bo);
  ok('sent: awaiting approval', s.header?.basis === 'awaiting_approval');
  await AP.decide(db, md, sb.pending.approvalId, { decision: 'reject', note: 'Rates too low' }, asMd);
  s = await screens(Bo);
  ok('rejected: back to the estimate (2 t × ₹25 lakh)', s.header?.basis === 'estimate' && near(s.header.amount, 5000000), j(s.header));
  ok('the run is dated today', !!T);
} catch (e) {
  console.error(e);
  ok(`no crash: ${e.message}`, false, e.problems ? j(e.problems) : '');
} finally {
  await db.rollback().catch(() => {});
  detachNodeCache(db);
  db.release();
}
const after = await H.counts();
const changed = after.filter((a) => Number(before.find((x) => x.name === a.name)?.n) !== Number(a.n));
ok('rolled back: every cf_ table is as it was', changed.length === 0, j(changed));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.failed ? `\n  ${H.state.fails.join('\n  ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
