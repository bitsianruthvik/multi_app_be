/**
 * purchase_flow_test.mjs — one purchase order, stage by stage
 * (services/purchaseFlowService.js, init.sql §46, CF_ERP_PURCHASE_FLOW_PLAN.md).
 *
 *   cd multi_app_be && node scripts/cf_kepl/purchase_flow_test.mjs
 *   CF_PFLOW_COMPANY=2 (default)
 *
 * A confirmed order short of A (5) and B (2); 1 of A free in stock.
 *   request from the order → Requested PO (A 5, B 2), bought for the order
 *   stock check → proposes holding 1 of A → hold it: A cut to 4, stock held for the order
 *   RFQ to S1 + S2 → Quoting / RFQ out → quotes from both → Quotes in
 *   accept A from S1, B from S2 → TWO ordered POs, prices + dates from the quotes,
 *     the order allocations moved with the lines
 *   GRN on S1's PO → received into stock, held for the order
 * One transaction, rolled back; every cf_ table re-counted.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { postMovement } from '../../apps/cf_erp/services/stockService.js';
import { receiveLine, getPurchaseOrder } from '../../apps/cf_erp/services/purchaseService.js';
import * as F from '../../apps/cf_erp/services/purchaseFlowService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PFLOW_COMPANY ?? 2);
const tag = `PFL${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const j = (v) => JSON.stringify(v);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();

try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('purchase_order', 'sales_order', 'stock_movement')", [COMPANY]);
  const node = (parentId, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')", [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key}`]);
  const variant = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');
  const item = async (key) => (await createItem(db, c, { classificationId: variant, code: `${tag}-${key}`, name: `${tag} ${key}`, status: 'active' })).id;
  const A = await item('A'); const B = await item('B'); const FG = await item('FG');
  const party = (key, role) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, status) VALUES (?, ?, ?, 1, 'active')`, [COMPANY, `${tag}-${key}`, `${tag} ${key}`]);
  const S1 = await party('S1', 'is_supplier'); const S2 = await party('S2', 'is_supplier'); const CUS = await party('CUS', 'is_customer');
  const store = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${tag}-ST`, `${tag} store`]);
  const so = await createOrder(db, c, { orderType: 'customer', customerId: CUS, code: `${tag}-SO`, committedDate: '2099-12-31' });
  const ol = await addOrderLine(db, c, so.id, { recordId: FG, quantity: 1 });
  await setOrderStatus(db, c, so.id, 'confirmed');
  const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, so.id, ol.lines[0].id, FG]);
  await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [COMPANY, rel, A, 5]);
  await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [COMPANY, rel, B, 2]);

  section('1. Requested — straight from the sales order');
  let short = await F.orderShortfall(db, COMPANY, so.id);
  ok('the order is short of A 5 and B 2', j(short.map((r) => [r.item.id, r.toBuy])) === j([[A, 5], [B, 2]].sort((x, y) => String(`${tag}-${x[0] === A ? 'A' : 'B'}`).localeCompare(`${tag}-${y[0] === A ? 'A' : 'B'}`))), j(short));
  let po = await F.requestFromOrder(db, c, so.id, {});
  ok('one PO, status Requested, bought for the order', po.status === 'requested' && po.forOrder?.id === so.id && po.lines.length === 2);
  ok('...every line allocated to the order', po.lines.every((l) => l.orders[0]?.orderId === so.id && l.orders[0].quantity === l.quantity));
  let board = await F.purchaseBoard(db, COMPANY, { orderId: so.id });
  const laneOf = (b, id) => b.lanes.find((l) => l.cards.some((x) => x.id === id))?.key ?? null;
  ok('board: in the Requested lane', laneOf(board, po.id) === 'requested');
  const empty = await refusal(() => F.requestFromOrder(db, c, so.id, { lines: [{ itemId: A, quantity: 0 }] }));
  ok('requesting nothing is refused in words', !!empty && /short of nothing|nothing to request/.test(JSON.stringify({ ...empty, m: empty.message })), empty?.message);

  section('2. Stock check — hold what is on the shelf, cut the PO');
  await postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId: A, quantity: 1, unitCost: 100 }] });
  const sc = await F.stockCheck(db, c, po.id);
  const lineA = sc.lines.find((l) => l.item.id === A);
  ok('proposes holding the 1 of A that is free', lineA.freeInStock === 1 && lineA.proposeHold === 1 && sc.canHold);
  const after = await F.applyStockCheck(db, c, po.id, { lines: [{ lineId: lineA.lineId, hold: 1 }] });
  po = after.purchaseOrder;
  ok('A is cut to 4 (and its allocation with it), B untouched', po.lines.find((l) => l.item.id === A).quantity === 4 && po.lines.find((l) => l.item.id === A).orders[0].quantity === 4 && po.lines.find((l) => l.item.id === B).quantity === 2);
  const [[held]] = await db.query("SELECT COALESCE(SUM(quantity),0) q FROM cf_stock_reservations WHERE held_for_order_id = ? AND item_id = ? AND status = 'active'", [so.id, A]);
  ok('the 1 of A is held for the sales order', Number(held.q) === 1);
  board = await F.purchaseBoard(db, COMPANY, { orderId: so.id });
  ok('board: Stock checked lane', laneOf(board, po.id) === 'stock_checked');
  const tooMuch = await refusal(() => F.applyStockCheck(db, c, po.id, { lines: [{ lineId: lineA.lineId, hold: 3 }] }));
  ok('holding more than is free is refused', !!tooMuch);

  section('3. RFQ out → Quotes in');
  let quotes = await F.sendRfq(db, c, po.id, { supplierIds: [S1, S2] });
  ok('RFQ sent to both, the PO is Quoting', quotes.purchaseOrder.status === 'quoting' && quotes.rfq?.suppliers?.length === 2, j({ s: quotes.purchaseOrder.status, n: quotes.rfq?.suppliers?.length }));
  board = await F.purchaseBoard(db, COMPANY, { orderId: so.id });
  ok('board: RFQ out (0 of 2 quoted)', laneOf(board, po.id) === 'rfq_out' && board.lanes.find((l) => l.key === 'rfq_out').cards.find((x) => x.id === po.id).tags.includes('0 of 2 quoted'));
  const rl = quotes.rfq.lines;
  const rA = rl.find((x) => (x.item?.id ?? x.itemId) === A); const rB = rl.find((x) => (x.item?.id ?? x.itemId) === B);
  quotes = await F.recordQuote(db, c, po.id, { supplierId: S1, quoteRef: 'Q-S1', lines: [{ rfqLineId: rA.id, unitPrice: 90, leadTimeDays: 7 }, { rfqLineId: rB.id, unitPrice: 60, leadTimeDays: 7 }] });
  quotes = await F.recordQuote(db, c, po.id, { supplierId: S2, quoteRef: 'Q-S2', lines: [{ rfqLineId: rA.id, unitPrice: 95, leadTimeDays: 3 }, { rfqLineId: rB.id, unitPrice: 50, leadTimeDays: 10 }] });
  board = await F.purchaseBoard(db, COMPANY, { orderId: so.id });
  ok('board: Quotes in', laneOf(board, po.id) === 'quotes_in');
  ok('the comparison sees both suppliers', (quotes.comparison?.suppliers ?? []).length === 2, j(quotes.comparison?.suppliers?.map((s) => s.supplier?.id ?? s.id)));

  section('4. Accept per line → the PO splits per supplier, Ordered');
  const ql = (supplierId, rfqLineId) => quotes.rfq.quotes.find((q) => (q.supplier?.id ?? q.supplierId) === supplierId).lines.find((l) => l.rfqLineId === rfqLineId).id;
  const placed = await F.placeOrder(db, c, po.id, { awards: [{ rfqLineId: rA.id, quoteLineId: ql(S1, rA.id) }, { rfqLineId: rB.id, quoteLineId: ql(S2, rB.id) }] });
  const [p1, p2] = placed.purchaseOrders;
  ok('two POs, both Ordered', placed.purchaseOrders.length === 2 && p1.status === 'ordered' && p2.status === 'ordered');
  ok('this PO went to S1 with A at ₹90; the split one to S2 with B at ₹50', p1.id === po.id && p1.supplier?.id === S1 && p1.lines.length === 1 && p1.lines[0].unitPrice === 90 && p2.supplier?.id === S2 && p2.lines[0].item.id === B && p2.lines[0].unitPrice === 50,
    j([p1.supplier?.id, p1.lines.map((l) => [l.item.id, l.unitPrice]), p2.supplier?.id, p2.lines.map((l) => [l.item.id, l.unitPrice])]));
  ok('each line has its expected date from the lead time', !!p1.lines[0].expectedDate && !!p2.lines[0].expectedDate);
  ok('the sales-order allocation moved with B to the new PO', p2.lines[0].orders[0]?.orderId === so.id && p2.lines[0].orders[0].quantity === 2);
  board = await F.purchaseBoard(db, COMPANY, { orderId: so.id });
  ok('board: both in Ordered', laneOf(board, p1.id) === 'ordered' && laneOf(board, p2.id) === 'ordered');

  section('5. GRN — received into stock, held for the order');
  const got = await receiveLine(db, c, p1.lines[0].id, { quantity: 4, stockingAreaId: store });
  ok('4 of A received; the PO is Received', got.order.status === 'received');
  ok('...and held for the sales order', got.held.some((h) => h.orderId === so.id && h.quantity === 4), j(got.held));
  board = await F.purchaseBoard(db, COMPANY, { orderId: so.id });
  ok('board: Received lane', laneOf(board, p1.id) === 'received');
  const fresh = await getPurchaseOrder(db, COMPANY, p2.id);
  ok('the S2 PO still waits for B', fresh.status === 'ordered' && fresh.lines[0].outstanding === 2);
  const direct = await F.requestFromOrder(db, c, so.id, { lines: [{ itemId: B, quantity: 1 }] });
  ok('a request can also be placed straight with a supplier (no RFQ) — it stays Requested until then', direct.status === 'requested');
} catch (err) {
  failed++;
  console.error('\nERROR', err);
} finally {
  await db.rollback();
  db.release();
}

const after2 = await counts();
const drift = after2.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
