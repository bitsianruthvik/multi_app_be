/**
 * buying_board_test.mjs — the Buying board, the procurement trace and an order's
 * documents (services/buyingBoardService.js, routes/buying.js).
 *
 *   cd multi_app_be && node scripts/cf_kepl/buying_board_test.mjs
 *   CF_BOARD_COMPANY=2 (default)
 *
 * A short item → purchase request draft / submitted / approved → RFQ draft / sent
 * → quote → award → draft PO → ordered → part received → received. After each
 * step the documents stand in the right column with the right counts and value;
 * the trace links both ways; the order filter sees exactly this order's
 * documents; the supplier filter only the RFQ / PO naming that supplier; round
 * trips stay a fixed handful.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table. It owns its classification, items,
 * parties, orders, release and stocking area; every name carries the run's tag
 * (and the board is read with search=<tag>, so other tenant data never counts).
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { markOrdered, receiveLine } from '../../apps/cf_erp/services/purchaseService.js';
import * as P from '../../apps/cf_erp/services/procurementService.js';
import { buyingBoard, procurementTrace, requestStage, rfqStage, poStage, BUYING_STAGES } from '../../apps/cf_erp/services/buyingBoardService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_BOARD_COMPANY ?? 2);
const tag = `BBD${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const result = await fn(); return { result, queries: n - at }; };

try {
  await conn.beginTransaction();
  const [users] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY]);
  if (users.length < 2) throw new Error(`Company ${COMPANY} needs two users.`);
  const [U1, U2] = users.map((u) => u.id);
  const buyer = { companyId: COMPANY, userId: U1, canManage: true, canApprove: true, isAdmin: false };
  const approver = { companyId: COMPANY, userId: U2, canManage: true, canApprove: true, isAdmin: false };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('purchase_order', 'purchase_request', 'rfq', 'sales_order', 'stock_movement')", [COMPANY]);

  // ---- fixture ---------------------------------------------------------------
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — buying board test`],
  );
  const variant = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');
  const party = (key, role) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, status) VALUES (?, ?, ?, 1, 'active')`, [COMPANY, `${tag}-${key}`, `${tag} ${key}`]);
  const S1 = await party('S1', 'is_supplier');
  const S2 = await party('S2', 'is_supplier');
  const S3 = await party('S3', 'is_supplier');
  const customer = await party('CUS', 'is_customer');
  const item = async (key, extra = {}) => (await createItem(db, buyer, { classificationId: variant, code: `${tag}-${key}`, name: `${tag} ${key}`, status: 'active', ...extra })).id;
  const A = await item('A', { listPrice: 95 });
  const B = await item('B');
  const FG = await item('FG');
  const area = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${tag}-ST`, `${tag} store`]);
  const order = async (key, reqs) => {
    const so = await createOrder(db, buyer, { orderType: 'customer', customerId: customer, code: `${tag}-${key}`, committedDate: '2099-12-31' });
    const o = await addOrderLine(db, buyer, so.id, { recordId: FG, quantity: 1 });
    await setOrderStatus(db, buyer, so.id, 'confirmed');
    const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, ?)', [COMPANY, so.id, o.lines[0].id, FG, 1]);
    for (const [it, qty] of reqs) await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [COMPANY, rel, it, qty]);
    return so;
  };
  const SO = await order('SO', [[A, 4], [B, 10]]);
  const OTHER = await order('SO2', []);                      // an order with no material: the order filter must show nothing for it

  const board = (extra = {}) => buyingBoard(db, COMPANY, { search: tag, ...extra });
  const col = (b, key) => b.columns.find((c) => c.key === key);
  const where = (b, type, id) => b.columns.find((c) => c.cards.some((x) => x.type === type && x.id === id))?.key ?? null;
  const card = (b, type, id) => b.columns.flatMap((c) => c.cards).find((x) => x.type === type && x.id === id) ?? null;
  const docCount = (b) => b.columns.filter((c) => c.key !== 'to_buy').reduce((t, c) => t + c.count, 0);

  section('0. Stage rules (pure)');
  ok('request: draft / submitted / rejected → Requested', ['draft', 'submitted', 'rejected'].every((s) => requestStage({ status: s }).column === 'requested'));
  ok('request: approved with an open line → Approved; all lines passed on → off the board (closed column, stage approved)',
    requestStage({ status: 'approved', open_lines: 1, passed_lines: 1 }).column === 'approved'
    && requestStage({ status: 'approved', open_lines: 0, passed_lines: 2 }).column === 'closed' && requestStage({ status: 'approved', open_lines: 0, passed_lines: 2 }).ended === 'passed');
  ok('RFQ: sent no quote → RFQ out; quote → Quotes in; awarded line not on PO → Awarded; status awarded → passed',
    rfqStage({ status: 'sent', quotes: 0 }).column === 'rfq_out' && rfqStage({ status: 'sent', quotes: 1 }).column === 'quotes_in'
    && rfqStage({ status: 'sent', quotes: 1, awarded_open: 1 }).column === 'awarded' && rfqStage({ status: 'awarded' }).ended === 'passed');
  ok('PO: draft → Awarded, ordered → Ordered, partially_received → Part received, received → Received, cancelled → closed',
    ['draft', 'ordered', 'partially_received', 'received', 'cancelled'].map((s) => poStage({ status: s }).column).join() === 'awarded,ordered,part_received,received,closed');
  ok('nine stages in order', BUYING_STAGES.map((s) => s.key).join() === 'to_buy,requested,approved,rfq_out,quotes_in,awarded,ordered,part_received,received');

  section('1. To buy');
  let b = await board();
  ok('nine columns, no Closed without includeClosed', b.columns.length === 9 && !col(b, 'closed'));
  ok('To buy: one summary card, 2 items short', col(b, 'to_buy').count === 2 && col(b, 'to_buy').cards.length === 1 && col(b, 'to_buy').cards[0].items === 2, JSON.stringify(col(b, 'to_buy')));
  ok('To buy value = A 4 × 95 = 380, B unpriced → part priced', col(b, 'to_buy').value === 380 && col(b, 'to_buy').cards[0].valueState === 'part' && b.toBuy.unpricedItems === 1, JSON.stringify(b.toBuy));
  ok('no document yet', docCount(b) === 0);
  const ob = await board({ orderId: SO.id, withRows: 1, search: undefined });
  ok('order filter: To buy = this order\'s 2 items, rows carry toRequest', ob.toBuy.items === 2 && ob.toBuy.rows.length === 2
    && ob.toBuy.rows.every((r) => r.toRequest === r.toBuy && r.sharedWith.length === 0) && ob.filters.order?.code === `${tag}-SO`, JSON.stringify(ob.toBuy.rows?.map((r) => [r.item.code, r.toRequest])));
  const ob2 = await board({ orderId: OTHER.id, search: undefined });
  ok('order filter on an order with no material: nothing anywhere', ob2.toBuy.items === 0 && docCount(ob2) === 0);
  ok('supplier filter: To buy, Requested, Approved stay empty (no supplier yet)', (await board({ supplierId: S1 })).columns.every((c) => c.count === 0));

  section('2. Purchase request: draft → submitted → approved');
  let pr = await P.requestFromBuyList(db, buyer, { rows: [{ itemId: A }, { itemId: B }] });
  await P.updateRequestLine(db, buyer, pr.lines.find((l) => l.item.id === B).id, { estUnitPrice: 20 });
  b = await board();
  ok('draft request → Requested, value 380 + 200 = 580 (estimate), 2 items', where(b, 'request', pr.id) === 'requested'
    && card(b, 'request', pr.id).value === 580 && card(b, 'request', pr.id).items === 2 && card(b, 'request', pr.id).valueState === 'full', JSON.stringify(card(b, 'request', pr.id)));
  ok('Requested header: count 1, value 580', col(b, 'requested').count === 1 && col(b, 'requested').value === 580);
  ok('To buy now empty: both items are in a request', col(b, 'to_buy').count === 0 && col(b, 'to_buy').cards.length === 0);
  ok('the card names who asked and links the request', card(b, 'request', pr.id).party?.id === U1 && card(b, 'request', pr.id).link === `purchase-requests/${pr.id}`);
  pr = await P.submitRequest(db, buyer, pr.id);
  b = await board();
  ok('submitted → still Requested, tagged waiting for approval', where(b, 'request', pr.id) === 'requested' && card(b, 'request', pr.id).tags.includes('Waiting for approval'));
  pr = await P.approveRequest(db, approver, pr.id, { note: 'ok' });
  b = await board();
  ok('approved → Approved (count 1, value 580); Requested empty', where(b, 'request', pr.id) === 'approved' && col(b, 'approved').count === 1 && col(b, 'approved').value === 580 && col(b, 'requested').count === 0);
  ok('order filter sees the request', where(await board({ orderId: SO.id, search: undefined }), 'request', pr.id) === 'approved');
  ok('the other order does not', docCount(await board({ orderId: OTHER.id, search: undefined })) === 0);

  section('3. RFQ: draft → sent → quote → award');
  let rfq = await P.createRfq(db, buyer, { requestId: pr.id });
  b = await board();
  ok('draft RFQ → RFQ out, tagged not sent; value from the request estimate 580', where(b, 'rfq', rfq.id) === 'rfq_out'
    && card(b, 'rfq', rfq.id).tags.some((t) => /not sent/.test(t)) && card(b, 'rfq', rfq.id).value === 580 && card(b, 'rfq', rfq.id).valueBasis === 'estimate', JSON.stringify(card(b, 'rfq', rfq.id)));
  ok('the request passed on: off the board (every line in the RFQ)', where(b, 'request', pr.id) === null && col(b, 'approved').count === 0);
  const bc = await board({ includeClosed: '1' });
  ok('with includeClosed the request stands in Closed / cancelled, passed on', where(bc, 'request', pr.id) === 'closed' && card(bc, 'request', pr.id).ended === 'passed' && bc.columns.length === 10);
  for (const s of [S1, S2]) rfq = await P.addRfqSupplier(db, buyer, rfq.id, { supplierId: s });
  rfq = await P.markRfqSent(db, buyer, rfq.id, { supplierId: S1 });
  b = await board();
  ok('sent → RFQ out, suppliers named, 0 of 2 quoted', where(b, 'rfq', rfq.id) === 'rfq_out' && card(b, 'rfq', rfq.id).suppliers.length === 2 && card(b, 'rfq', rfq.id).tags.includes('0 of 2 quoted'));
  ok('supplier filter S1 → the RFQ; S3 → nothing', where(await board({ supplierId: S1 }), 'rfq', rfq.id) === 'rfq_out' && docCount(await board({ supplierId: S3 })) === 0);
  const L = Object.fromEntries(rfq.lines.map((l) => [l.item.id, l.id]));
  rfq = await P.upsertQuote(db, buyer, rfq.id, { supplierId: S1, lines: [{ rfqLineId: L[A], unitPrice: 100 }, { rfqLineId: L[B], unitPrice: 15 }] });
  b = await board();
  ok('a quote in → Quotes in; value from the cheapest quote 4 × 100 + 10 × 15 = 550', where(b, 'rfq', rfq.id) === 'quotes_in'
    && card(b, 'rfq', rfq.id).value === 550 && card(b, 'rfq', rfq.id).valueBasis === 'quoted' && col(b, 'quotes_in').value === 550, JSON.stringify(card(b, 'rfq', rfq.id)));
  rfq = await P.upsertQuote(db, buyer, rfq.id, { supplierId: S2, lines: [{ rfqLineId: L[A], unitPrice: 90 }] });
  b = await board();
  ok('a cheaper quote on A → value 4 × 90 + 150 = 510', card(b, 'rfq', rfq.id).value === 510, String(card(b, 'rfq', rfq.id)?.value));
  const ql = (s, it) => rfq.quotes.find((q) => q.supplierId === s).lines.find((l) => l.rfqLineId === L[it]).id;
  rfq = await P.awardRfq(db, buyer, rfq.id, { awards: [{ rfqLineId: L[A], quoteLineId: ql(S1, A) }, { rfqLineId: L[B], quoteLineId: ql(S1, B) }] });
  b = await board();
  ok('awarded, no PO yet → Awarded; value from the award 550', where(b, 'rfq', rfq.id) === 'awarded' && card(b, 'rfq', rfq.id).value === 550 && card(b, 'rfq', rfq.id).valueBasis === 'awarded');

  section('4. Purchase order: draft → ordered → part received → received');
  const made = await P.createPosFromRfq(db, buyer, rfq.id);
  const po = made.purchaseOrders[0];
  ok('one draft PO for S1', made.purchaseOrders.length === 1 && po.supplier.id === S1);
  b = await board();
  ok('draft PO → Awarded ("Draft PO"), value 550; the RFQ passed on', where(b, 'po', po.id) === 'awarded' && card(b, 'po', po.id).value === 550
    && card(b, 'po', po.id).tags.some((t) => /Draft PO/.test(t)) && where(b, 'rfq', rfq.id) === null, JSON.stringify(card(b, 'po', po.id)));
  ok('Awarded header: count 1, value 550 (no double count with the RFQ)', col(b, 'awarded').count === 1 && col(b, 'awarded').value === 550);
  await markOrdered(db, buyer, po.id, {});
  b = await board();
  ok('ordered → Ordered, supplier named', where(b, 'po', po.id) === 'ordered' && card(b, 'po', po.id).party?.id === S1 && col(b, 'ordered').count === 1);
  ok('order filter follows request line → RFQ line → PO line to the PO', where(await board({ orderId: SO.id, search: undefined }), 'po', po.id) === 'ordered');
  ok('supplier filter S2 (quoted, not awarded) → the PO is not theirs', where(await board({ supplierId: S2 }), 'po', po.id) === null);
  const poLines = (await db.query('SELECT id, item_id FROM cf_purchase_order_lines WHERE purchase_order_id = ? AND deleted_at IS NULL', [po.id]))[0];
  const lineOf = (it) => poLines.find((l) => l.item_id === it).id;
  await receiveLine(db, buyer, lineOf(A), { quantity: 4, stockingAreaId: area });
  b = await board();
  ok('part received → Part received, "4 of 14 in", 1 receipt', where(b, 'po', po.id) === 'part_received' && card(b, 'po', po.id).tags.includes('4 of 14 in')
    && card(b, 'po', po.id).receipts?.count === 1, JSON.stringify(card(b, 'po', po.id)?.tags));
  await receiveLine(db, buyer, lineOf(B), { quantity: 10, stockingAreaId: area });
  b = await board();
  ok('received → Received, value 550, 2 receipts', where(b, 'po', po.id) === 'received' && card(b, 'po', po.id).value === 550 && card(b, 'po', po.id).receipts?.count === 2);
  ok('every other column of ours is empty now', b.columns.filter((c) => c.key !== 'received').every((c) => c.count === 0), b.columns.map((c) => `${c.key}:${c.count}`).join(' '));
  const ofOrder = await board({ orderId: SO.id, search: undefined });
  ok('order view: the PO in Received, its 2 receipts listed, To buy empty', where(ofOrder, 'po', po.id) === 'received' && ofOrder.receipts?.length === 2 && ofOrder.toBuy.items === 0
    && ofOrder.receipts.every((r) => r.purchaseOrder.id === po.id), JSON.stringify(ofOrder.receipts));

  section('5. Trace both ways');
  const tPr = await procurementTrace(db, COMPANY, { type: 'request', id: pr.id });
  ok('request → its RFQ, its PO and the PO\'s receipts; reached Received', tPr.rfqs.map((x) => x.id).join() === String(rfq.id)
    && tPr.purchaseOrders.map((x) => x.id).join() === String(po.id) && tPr.receipts.length === 2 && tPr.reached === 'received' && tPr.stage === 'approved', JSON.stringify({ ...tPr, stages: undefined }).slice(0, 400));
  const tRfq = await procurementTrace(db, COMPANY, { type: 'rfq', id: rfq.id });
  ok('RFQ → the request it came from and the PO it made', tRfq.requests.map((x) => x.id).join() === String(pr.id) && tRfq.purchaseOrders.map((x) => x.id).join() === String(po.id) && tRfq.stage === 'awarded');
  const tPo = await procurementTrace(db, COMPANY, { type: 'po', id: po.id });
  ok('PO → the RFQ and request it came from, and its receipts; stage Received', tPo.rfqs.map((x) => x.id).join() === String(rfq.id) && tPo.requests.map((x) => x.id).join() === String(pr.id)
    && tPo.receipts.length === 2 && tPo.stage === 'received' && tPo.document.code === po.code);
  ok('linked documents carry their link paths', tPo.rfqs[0].link === `rfqs/${rfq.id}` && tPo.requests[0].link === `purchase-requests/${pr.id}` && tPo.receipts[0].link.startsWith('movements/'));
  let e = await refusal(() => procurementTrace(db, COMPANY, { type: 'invoice', id: 1 }));
  ok('a bad type → 422', e?.status === 422);
  e = await refusal(() => procurementTrace(db, COMPANY, { type: 'po', id: 999999999 }));
  ok('an unknown id → 404', e?.status === 404);
  // A PO raised by hand has no request behind it: its trace is itself alone, and the order filter cannot see it (a known gap).
  const [hand] = await db.query("INSERT INTO cf_purchase_orders (company_id, code, supplier_id, status) VALUES (?, ?, ?, 'draft')", [COMPANY, `${tag}-HAND`, S3]);
  const tHand = await procurementTrace(db, COMPANY, { type: 'po', id: hand.insertId });
  ok('a hand-raised PO: trace with no request, RFQ or receipt', tHand.requests.length === 0 && tHand.rfqs.length === 0 && tHand.receipts.length === 0 && tHand.stage === 'awarded');
  ok('search by its code finds it in Awarded; the order filter does not', where(await board({ search: `${tag}-HAND` }), 'po', hand.insertId) === 'awarded'
    && where(await board({ orderId: SO.id, search: undefined }), 'po', hand.insertId) === null);

  section('6. Cap and "N more"');
  const capped = await board({ search: tag, limit: 1, includeClosed: '1' });
  const closedCol = col(capped, 'closed');
  ok('limit 1: Closed shows 1 card, more = count − 1, link to the list', closedCol.cards.length === 1 && closedCol.more === closedCol.count - 1 && closedCol.count >= 2 && !!closedCol.moreLink?.path, JSON.stringify({ c: closedCol.count, m: closedCol.more }));

  section('7. Round trips (TiDB is ~49 ms away)');
  const all = await measured(() => buyingBoard(db, COMPANY, {}));
  const byOrder = await measured(() => buyingBoard(db, COMPANY, { orderId: SO.id, withRows: 1 }));
  const bySupplier = await measured(() => buyingBoard(db, COMPANY, { supplierId: S1 }));
  const tr = await measured(() => procurementTrace(db, COMPANY, { type: 'request', id: pr.id }));
  console.log(`  board ${all.queries} · by order ${byOrder.queries} · by supplier ${bySupplier.queries} · trace ${tr.queries}`);
  ok('board ≤ 20 statements (buy list + 5 aggregates), whatever the document count', all.queries <= 20, String(all.queries));
  ok('order board ≤ 23 (+2 scope, +1 receipts, +1 order name)', byOrder.queries <= 23, String(byOrder.queries));
  ok('supplier board skips the buy list and requests: ≤ 6', bySupplier.queries <= 6, String(bySupplier.queries));
  ok('trace = 1 edges + 6 readers + 1 receipts ≤ 8', tr.queries <= 8, String(tr.queries));
} catch (err) {
  failed++;
  console.error('\nERROR', err);
} finally {
  await conn.rollback();
  conn.release();
}

const after = await counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
