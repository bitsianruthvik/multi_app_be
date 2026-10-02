/**
 * po_order_link_test.mjs — purchase orders bought FOR a sales order, and what
 * arrives held for it (init.sql §43, services/purchaseLinkService.js).
 *
 *   cd multi_app_be && node scripts/cf_kepl/po_order_link_test.mjs
 *   CF_LINK_COMPANY=2 (default)
 *
 * Two orders short of one item → the buy list splits the shortage per order →
 * Suggest's line is bought for both → a hand PO with a header order → line
 * allocations edited, refused, trimmed → linked on-order covers only its order →
 * receipt holds each order's share → held stock is free for its order only →
 * release takes the order's holds first → the order's Buying stage sees the
 * POs and the holds → let a hold go → closing an order lets its holds go.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table.
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import {
  buyList, suggestPurchase, createPurchaseOrder, addPurchaseLine, updatePurchaseLine, setPurchaseLineOrders,
  markOrdered, receiveLine, getPurchaseOrder, listPurchaseOrders,
} from '../../apps/cf_erp/services/purchaseService.js';
import { releaseHold } from '../../apps/cf_erp/services/purchaseLinkService.js';
import { splitTo } from '../../apps/cf_erp/services/procurementService.js';
import { availability, reserveRelease } from '../../apps/cf_erp/services/releaseService.js';
import { buyingBoard } from '../../apps/cf_erp/services/buyingBoardService.js';
import { itemStock } from '../../apps/cf_erp/services/stockService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_LINK_COMPANY ?? 2);
const tag = `POL${Date.now().toString(36).toUpperCase()}`;

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
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: false };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('purchase_order', 'sales_order', 'stock_movement')", [COMPANY]);

  // ---- fixture ---------------------------------------------------------------
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — po link test`],
  );
  const variant = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');
  const party = (key, role) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, status) VALUES (?, ?, ?, 1, 'active')`, [COMPANY, `${tag}-${key}`, `${tag} ${key}`]);
  const SUP = await party('SUP', 'is_supplier');
  const CUS = await party('CUS', 'is_customer');
  const item = async (key) => (await createItem(db, c, { classificationId: variant, code: `${tag}-${key}`, name: `${tag} ${key}`, status: 'active' })).id;
  const A = await item('A');
  const B = await item('B');
  const FG = await item('FG');
  const area = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${tag}-ST`, `${tag} store`]);
  const order = async (key, reqs) => {
    const so = await createOrder(db, c, { orderType: 'customer', customerId: CUS, code: `${tag}-${key}`, committedDate: '2099-12-31' });
    const o = await addOrderLine(db, c, so.id, { recordId: FG, quantity: 1 });
    await setOrderStatus(db, c, so.id, 'confirmed');
    const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, ?)', [COMPANY, so.id, o.lines[0].id, FG, 1]);
    for (const [it, qty] of reqs) await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [COMPANY, rel, it, qty]);
    return { ...so, releaseId: rel };
  };
  const SO1 = await order('SO1', [[A, 10]]);
  const SO2 = await order('SO2', [[A, 6]]);
  const rowOf = async (itemId) => (await buyList(db, COMPANY, { show: 'all', search: tag })).find((r) => r.item.id === itemId && !r.planned);
  const sum = (xs, k = 'quantity') => Math.round(xs.reduce((t, x) => t + Number(x[k]), 0) * 1e6) / 1e6;

  section('1. The buy list splits a shared shortage per order');
  let r = await rowOf(A);
  ok('A: wanted 16, to buy 16, nothing held', r.wanted === 16 && r.toBuy === 16 && r.held === 0, j(r));
  ok('split: SO1 10, SO2 6', j(r.split.map((x) => [x.orderCode, x.toBuy])) === j([[`${tag}-SO1`, 10], [`${tag}-SO2`, 6]]), j(r.split));

  section('2. Suggest buys each line for the orders short of it');
  // Other tenant data may be short too; only our item's line matters.
  const sg = await suggestPurchase(db, c);
  let po = sg.order;
  let la = po.lines.find((l) => l.item.id === A);
  ok('Suggest line A 16, bought for SO1 10 + SO2 6, nothing unlinked',
    la.quantity === 16 && j(la.orders.map((o) => [o.orderId, o.quantity])) === j([[SO1.id, 10], [SO2.id, 6]]) && la.unlinked === 0, j(la));
  const again = (await suggestPurchase(db, c)).order;
  const la2 = again.lines.find((l) => l.item.id === A);
  ok('Suggest again rewrites the same PO; the line is bought for the same orders, not twice', again.id === po.id && sum(la2.orders) === 16, j(la2.orders));
  r = await rowOf(A);
  ok('after Suggest: to buy 0, on order 16 (all of it bought for these orders)', r.toBuy === 0 && r.onOrder === 16, j(r));

  section('3. A hand PO: the header order is the default for new lines');
  let hp = await createPurchaseOrder(db, c, { forOrderId: SO1.id });
  ok('header says For SO1', hp.forOrder?.id === SO1.id, j(hp.forOrder));
  hp = await addPurchaseLine(db, c, hp.id, { itemId: A, quantity: 5 });
  let hl = hp.lines.find((l) => l.item.id === A);
  ok('line A 5 takes the header order: SO1 5', j(hl.orders.map((o) => [o.orderId, o.quantity])) === j([[SO1.id, 5]]), j(hl.orders));
  hp = await addPurchaseLine(db, c, hp.id, { itemId: B, quantity: 2, orderId: null });
  ok('a line added with orderId null is for stock', hp.lines.find((l) => l.item.id === B).orders.length === 0 && hp.lines.find((l) => l.item.id === B).unlinked === 2);
  hp = await setPurchaseLineOrders(db, c, hl.id, { orders: [{ orderId: SO1.id, quantity: 3 }, { orderId: SO2.id, quantity: 2 }] });
  hl = hp.lines.find((l) => l.item.id === A);
  ok('allocations replaced: SO1 3, SO2 2', j(hl.orders.map((o) => [o.orderId, o.quantity])) === j([[SO1.id, 3], [SO2.id, 2]]), j(hl.orders));
  let e = await refusal(() => setPurchaseLineOrders(db, c, hl.id, { orders: [{ orderId: SO1.id, quantity: 4 }, { orderId: SO2.id, quantity: 2 }] }));
  ok('more for orders than the line holds is refused', !!e && /only 5/.test(JSON.stringify({ ...e, message: e.message })), e?.message);
  e = await refusal(() => setPurchaseLineOrders(db, c, hl.id, { orders: [{ orderId: SO1.id, quantity: 1 }, { orderId: SO1.id, quantity: 1 }] }));
  ok('the same order twice is refused', !!e);
  const list = await listPurchaseOrders(db, COMPANY, { status: 'all', search: hp.code });
  ok('PO list row: forOrder SO1 and order codes SO1, SO2', list[0]?.forOrder?.id === SO1.id && j(list[0].orderCodes) === j([`${tag}-SO1`, `${tag}-SO2`]), j(list[0]));

  section('4. Bought for an order covers only that order');
  const SO3 = await order('SO3', [[A, 4]]);
  r = await rowOf(A);
  ok('SO3 (no PO for it) still has to buy 4 — the 21 on order are all for SO1/SO2', r.split.length === 1 && r.split[0].orderId === SO3.id && r.split[0].toBuy === 4 && r.toBuy === 4, j(r));

  section('5. A quantity cut trims allocations newest first');
  hp = await updatePurchaseLine(db, c, hl.id, { quantity: 3 });
  hl = hp.lines.find((l) => l.item.id === A);
  ok('line 5 → 3: SO2 2 goes, SO1 3 stays', j(hl.orders.map((o) => [o.orderId, o.quantity])) === j([[SO1.id, 3]]), j(hl.orders));

  section('6. Receiving holds each order\'s share');
  po = await markOrdered(db, c, po.id, { supplierId: SUP });
  la = po.lines.find((l) => l.item.id === A);
  const got = await receiveLine(db, c, la.id, { quantity: 12, stockingAreaId: area });
  ok('12 received: held SO1 10, SO2 2', j(got.held.map((h) => [h.orderId, h.quantity])) === j([[SO1.id, 10], [SO2.id, 2]]), j(got.held));
  la = got.order.lines.find((l) => l.item.id === A);
  ok('allocations remember what arrived: SO1 10/10, SO2 2/6', j(la.orders.map((o) => [o.received, o.quantity])) === j([[10, 10], [2, 6]]), j(la.orders));
  const avOther = (await availability(db, COMPANY, [A])).get(A);
  const avSO1 = (await availability(db, COMPANY, [A], { orderId: SO1.id })).get(A);
  const avSO3 = (await availability(db, COMPANY, [A], { orderId: SO3.id })).get(A);
  ok('free for nobody in general: 12 on hand, 12 reserved', avOther.available === 12 && avOther.free === 0, j(avOther));
  ok('free for SO1: its 10 held (SO2\'s 2 stay reserved)', avSO1.free === 10, j(avSO1));
  ok('free for SO3: 0', avSO3.free === 0, j(avSO3));
  r = await rowOf(A);
  ok('buy list: held 12 counted for their orders; SO3 still short 4', r.held === 12 && r.toBuy === 4, j(r));
  e = await refusal(() => setPurchaseLineOrders(db, c, la.id, { orders: [{ orderId: SO1.id, quantity: 9 }, { orderId: SO2.id, quantity: 6 }] }));
  ok('an allocation cannot go below what arrived for it', !!e);

  section('7. Release takes the order\'s holds first');
  const resv = await reserveRelease(db, c, SO1.releaseId);
  ok('SO1 release reserved its 10 with nothing short', resv.short.length === 0, j(resv.short));
  const [[h1]] = await db.query("SELECT COALESCE(SUM(quantity), 0) AS q FROM cf_stock_reservations WHERE company_id = ? AND held_for_order_id = ? AND status = 'active'", [COMPANY, SO1.id]);
  const [[rq]] = await db.query("SELECT COALESCE(SUM(v.quantity), 0) AS q FROM cf_stock_reservations v JOIN cf_material_requirements q ON q.id = v.requirement_id WHERE q.release_id = ? AND v.status = 'active'", [SO1.releaseId]);
  ok('SO1\'s hold is used up and its requirement holds 10', Number(h1.q) === 0 && Number(rq.q) === 10, `${h1.q} / ${rq.q}`);
  const avAfter = (await availability(db, COMPANY, [A])).get(A);
  ok('nothing reserved twice: 12 reserved of 12', avAfter.reserved === 12 && avAfter.free === 0, j(avAfter));

  section('8. The order\'s Buying stage sees its POs and holds');
  const b2 = await buyingBoard(db, COMPANY, { orderId: SO2.id, includeClosed: 1 });
  const poIds = b2.columns.flatMap((col) => col.cards).filter((x) => x.type === 'po').map((x) => x.id);
  ok('SO2 board shows the Suggest PO (ordered, part received)', poIds.includes(po.id), j(poIds));
  ok('SO2 board does not show the hand PO (its SO2 share was trimmed)', !poIds.includes(hp.id), j(poIds));
  ok('SO2 held: one row, 2 of A, from the Suggest PO', b2.held?.total === 1 && b2.held.rows[0].quantity === 2 && b2.held.rows[0].purchaseOrder?.id === po.id, j(b2.held));
  const b1 = await buyingBoard(db, COMPANY, { orderId: SO1.id, includeClosed: 1 });
  ok('SO1 board shows the hand PO (bought for SO1 by hand)', b1.columns.flatMap((col) => col.cards).some((x) => x.type === 'po' && x.id === hp.id));
  const st = await itemStock(db, COMPANY, A);
  const held = st.reservations.filter((v) => v.kind === 'held');
  ok('item stock lists the hold: SO2, from the PO, no line', held.length === 1 && held[0].order.id === SO2.id && held[0].purchaseOrder?.id === po.id && held[0].lineNo === null, j(held));

  section('9. Let a hold go; closing an order lets its holds go');
  ok('let go of SO2\'s hold', (await releaseHold(db, c, held[0].id)).ok === true);
  ok('the 2 are free again', (await availability(db, COMPANY, [A])).get(A).free === 2);
  e = await refusal(() => releaseHold(db, c, held[0].id));
  ok('letting it go twice is refused', !!e);
  const got2 = await receiveLine(db, c, la.id, { quantity: 4, stockingAreaId: area });
  ok('4 more: held for SO2 (its 6 less the 2 already arrived)', j(got2.held.map((h) => [h.orderId, h.quantity])) === j([[SO2.id, 4]]), j(got2.held));
  await setOrderStatus(db, c, SO2.id, 'closed');
  const [[h2]] = await db.query("SELECT COUNT(*) AS n FROM cf_stock_reservations WHERE company_id = ? AND held_for_order_id = ? AND status = 'active'", [COMPANY, SO2.id]);
  ok('closing SO2 lets its hold go', Number(h2.n) === 0);
  e = await refusal(() => createPurchaseOrder(db, c, { forOrderId: SO2.id }));
  ok('a closed order cannot be bought for', !!e);

  section('10. Request → RFQ → PO carries the split (pure)');
  ok('splitTo cuts to the quantity, first orders first',
    j(splitTo([{ orderId: 1, orderCode: 'A', toBuy: 5 }, { orderId: 2, orderCode: 'B', toBuy: 4 }, { orderId: 1, orderCode: 'A', toBuy: 1 }], 7))
      === j([{ orderId: 1, orderCode: 'A', quantity: 6 }, { orderId: 2, orderCode: 'B', quantity: 1 }]));

  const fresh = await getPurchaseOrder(db, COMPANY, po.id);
  ok('the PO reads back with its allocations', fresh.lines.find((l) => l.item.id === A).orders.length === 2);
} catch (err) {
  failed++;
  console.error('\nERROR', err);
} finally {
  await db.rollback();
  db.release();
}

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
