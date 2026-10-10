/**
 * buying_v2_test.mjs — Buying v2 (init.sql §56, TM/CF_ERP_BUYING_V2.md): the
 * REQUISITION of a sales-order line, the one material-ready engine on the
 * server, and production that really waits for its material.
 *
 *   cd multi_app_be && node scripts/cf_kepl/buying_v2_test.mjs
 *   CF_BUY_COMPANY=2 (default)     CF_BUY_ONLY=7,8 (run only those sections)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing
 * it does is re-count every cf_ table. ITS FIXTURES ARE ITS OWN
 * (lib/buyingFixture.mjs) — no tenant row is borrowed. TODAY IS SET: 2026-10-12,
 * a Monday (materialReadyService.setToday), so every date is deterministic.
 *
 * Every scenario asserts the ENGINE's state / date per plan unit AND that the
 * PLANNER blocks accordingly (GET /planner's units[].material and
 * entries[].blocked; PUT /planner/entries refusing with MATERIAL_NOT_READY).
 *
 *    1  a requisition served ENTIRELY from stock            11  A's PO never feeds B; an unallocated PO line is pooled
 *    2  one requisition split into THREE POs (3 dates)      12  requested / quoting = waiting; placed with dates = dated
 *    3  one PO whose LINES have different dates             13  RFQ → quotes → place, split over two suppliers
 *    4  a PO date moves later, then earlier                 14  one line: stock + PO + skipped
 *    5  partial receipt; over-receipt refused               15  a RELEASED line blocks the same; the step's refusal
 *    6  buying SKIPPED (one material, and all)              16  lifecycle
 *    7  …stock is added                                     17  customer-owned stock
 *    8  …and then held / reserved for another order        (18 query counts and 19 the migration: buying_v2_scale_test.mjs;
 *    9  two skipped orders compete: priority decides            real HTTP, permissions, tenants: buying_v2_http_test.mjs)
 *   10  earmark invisibility, each reader separately
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import * as MR from '../../apps/cf_erp/services/materialReadyService.js';
import * as RQ from '../../apps/cf_erp/services/requisitionService.js';
import * as PF from '../../apps/cf_erp/services/purchaseFlowService.js';
import * as PS from '../../apps/cf_erp/services/purchaseService.js';
import * as PL from '../../apps/cf_erp/services/plannerService.js';
import * as REL from '../../apps/cf_erp/services/releaseService.js';
import * as SO from '../../apps/cf_erp/services/salesOrderService.js';
import * as REV from '../../apps/cf_erp/services/revisionService.js';
import * as LOCK from '../../apps/cf_erp/services/lockService.js';
import * as OWN from '../../apps/cf_erp/services/ownershipService.js';
import * as ST from '../../apps/cf_erp/services/stockService.js';
import { orderProcess } from '../../apps/cf_erp/services/processService.js';
import { releaseHold } from '../../apps/cf_erp/services/purchaseLinkService.js';
import { availability } from '../../apps/cf_erp/services/rollOutService.js';
import { harness, simple, girder, quietCodes, addDays, PER_GIRDER } from './lib/buyingFixture.mjs';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_BUY_COMPANY ?? 2);
const ONLY = process.env.CF_BUY_ONLY ? new Set(process.env.CF_BUY_ONLY.split(',').map((x) => x.trim())) : null;
const tag = `BV${Date.now().toString(36).toUpperCase()}`;
const TODAY = '2026-10-12';
const D = (n) => addDays(TODAY, n);

const H = harness(pool);
const { ok, section, says, refusal, j } = H;
const before = await H.counts();
const db = await pool.getConnection();
const run = (n) => !ONLY || ONLY.has(String(n));

try {
  await db.beginTransaction();
  attachNodeCache(db);
  MR.setToday(TODAY);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  await quietCodes(db, COMPANY);
  const F = await simple(db, c, tag, { itemKeys: [] });

  // ---- what the scenarios read ---------------------------------------------------------------
  const lineState = async (lineId) => (await MR.lineReadiness(db, COMPANY, { full: true })).byLine.get(Number(lineId));
  const reasonOf = (res, itemId) => res.reasons.find((r) => Number(r.item.id) === Number(itemId));
  const snapshot = () => PL.getPlanner(db, COMPANY, { from: '2026-10-01' });
  const unitOf = (snap, key) => snap.units.find((u) => u.key === key);
  const place = (unitKey, shipDate, extra = {}) => PL.putEntries(db, c, { entries: [{ unitKey, shipDate, pinned: true, ...extra }] });
  const unplace = (unitKey) => PL.putEntries(db, c, { entries: [{ unitKey, shipDate: null }] });
  const prOf = async (orderId, lineId = null) => {
    const all = await RQ.orderRequisitions(db, COMPANY, orderId);
    return lineId == null ? all.requisitions[0] : all.requisitions.find((r) => r.line.id === Number(lineId));
  };
  const prLine = (pr, itemId) => pr.lines.find((l) => Number(l.item.id) === Number(itemId));
  const buyingStage = async (orderId, lineId) => (await orderProcess(db, COMPANY, orderId)).lines.find((l) => l.lineId === Number(lineId)).stages.find((s) => s.stageKey === 'buying');
  const activeHolds = async (itemId) => (await db.query("SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q FROM cf_stock_reservations WHERE company_id = ? AND item_id = ? AND status = 'active' AND deleted_at IS NULL", [COMPANY, itemId]))[0][0];
  const posOfOrder = async (orderId) => (await PF.purchaseBoard(db, COMPANY, { orderId })).lanes.flatMap((l) => l.cards);
  /** A purchase order made from requisition lines and placed with dates: lines [[prLineId, qty, date]]. */
  const buy = (lines, { supplier = F.S1, place: placed = true, date = null } = {}) => RQ.makePurchaseOrders(db, c, {
    orders: [{ supplierId: supplier, place: placed, expectedDate: date, lines: lines.map(([prLineId, quantity, expectedDate]) => ({ prLineId, quantity, expectedDate })) }],
  });
  const WEEK = (iso) => PL.periodFloor(iso);

  /* ============================================================================================ */
  if (run(1)) {
    section('1. A requisition served ENTIRELY from stock');
    const A = await F.item('S1A'); const B = await F.item('S1B');
    await F.receive(A, 10); await F.receive(B, 4);
    const O = await F.order('O1', [[[A, 10], [B, 4]]]);
    let r = await RQ.raiseRequisitions(db, c, O.id, {});
    ok('raising makes one requisition for the line, with a line per material', r.raised === 1 && r.requisitions.length === 1 && r.requisitions[0].lines.length === 2, j([r.raised, r.requisitions.length]));
    let pr = r.requisitions[0];
    ok('its need is the line\'s own material: A 10, B 4', prLine(pr, A).need === 10 && prLine(pr, B).need === 4);
    ok('RAISING EARMARKS NOTHING: no hold exists, the requisition is open', Number((await activeHolds(A)).n) === 0 && pr.status === 'open' && prLine(pr, A).status === 'open', pr.status);
    ok('…yet the stock is there, so the engine says plannable NOW, soft (not earmarked)', pr.materialReady.state === 'ready' && pr.materialReady.soft === true, j(pr.materialReady));
    let st = await buyingStage(O.id, O.line.id);
    ok('Buying is NOT done on unearmarked stock — it asks for a decision', st.state === 'todo' && /in stock but not held/.test(st.detail), st.detail);
    says(st.detail);
    const dry = await RQ.stockCheck(db, c, pr.id, {});
    ok('the stock check, dry run: proposes to hold A 10 and B 4, writes nothing', dry.applied === false && dry.canApply && j(dry.lines.map((l) => [l.item.id, l.freeInStock, l.proposeHold]).sort()) === j([[A, 10, 10], [B, 4, 4]].sort()) && Number((await activeHolds(A)).n) === 0, j(dry.lines));
    const done = await RQ.stockCheck(db, c, pr.id, { apply: true });
    pr = done.requisition;
    const [holds] = await db.query("SELECT item_id, quantity, pr_line_id, held_for_order_id FROM cf_stock_reservations WHERE company_id = ? AND held_for_order_id = ? AND status = 'active' ORDER BY item_id", [COMPANY, O.id]);
    ok('apply: the holds are on the REQUISITION LINES (and still say the order)', done.applied && holds.length === 2 && holds.every((h) => h.pr_line_id != null && h.held_for_order_id === O.id)
      && Number(holds.find((h) => h.item_id === A).quantity) === 10 && holds.find((h) => h.item_id === A).pr_line_id === prLine(pr, A).id, j(holds));
    ok('the requisition is FULFILLED FROM STOCK', pr.status === 'fulfilled_from_stock' && pr.done === true && pr.lines.every((l) => l.status === 'from_stock'), pr.status);
    says(pr.sentence);
    ok('NO purchase order exists for the order — not even a cancelled one', (await posOfOrder(O.id)).length === 0
      && Number((await db.query('SELECT COUNT(*) AS n FROM cf_purchase_orders WHERE company_id = ? AND for_order_id = ?', [COMPANY, O.id]))[0][0].n) === 0);
    const res = await lineState(O.line.id);
    ok('engine: the unit is READY today, held (not soft)', res.state === 'ready' && res.readyDate === TODAY && res.soft === false && reasonOf(res, A).cover[0].kind === 'held', j([res.state, res.soft]));
    const snap = await snapshot();
    const u = unitOf(snap, O.line.unitKey);
    ok('planner snapshot carries the same on the unit', u.material.state === 'ready' && u.material.earliest === null && u.material.reasons.length === 0, j(u.material));
    ok('planner: the unit can be placed this week', !!(await place(O.line.unitKey, TODAY)).entries[O.line.unitKey]);
    st = await buyingStage(O.id, O.line.id);
    ok('Buying is DONE: 2 held in stock', st.state === 'done' && /2 held in stock/.test(st.detail) && st.summary.fromStock === 2, st.detail);
    const again = await RQ.stockCheck(db, c, pr.id, {});
    ok('a second stock check proposes nothing (its own holds are cover, not stock to hold again)', again.canApply === false && again.lines.every((l) => l.proposeHold === 0 && l.freeInStock === 0), j(again.lines));
  }

  /* ============================================================================================ */
  if (run(3)) {
    section('3. One PO whose LINES have different dates');
    const P1 = await F.item('S3P'); const P2 = await F.item('S3Q');
    const O = await F.order('O3', [[[P1, 2]], [[P1, 3], [P2, 1]]]);
    const r = await RQ.raiseRequisitions(db, c, O.id, {});
    const [x, y] = [r.requisitions.find((q) => q.line.id === O.lines[0].id), r.requisitions.find((q) => q.line.id === O.lines[1].id)];
    const made = await buy([[prLine(x, P1).id, 2, D(8)], [prLine(y, P1).id, 3, D(8)], [prLine(y, P2).id, 1, D(29)]]);
    const po = made.purchaseOrders[0];
    ok('ONE purchase order, two lines (one per item), the P1 line shared by two requisition lines', made.purchaseOrders.length === 1 && po.lines.length === 2
      && po.lines.find((l) => l.item.id === P1).for.length === 2 && po.lines.find((l) => l.item.id === P1).quantity === 5, j(po.lines.map((l) => [l.item.id, l.quantity, l.for.length])));
    ok('its lines carry their own dates', po.lines.find((l) => l.item.id === P1).expectedDate === D(8) && po.lines.find((l) => l.item.id === P2).expectedDate === D(29));
    const a = await lineState(O.lines[0].id); const b = await lineState(O.lines[1].id);
    ok(`the unit that needs only the early line is dated ${D(8)}`, a.state === 'dated' && a.readyDate === D(8), j([a.state, a.readyDate]));
    ok(`the unit that also needs the late line is dated ${D(29)} — later`, b.state === 'dated' && b.readyDate === D(29), j([b.state, b.readyDate]));
    const snap = await snapshot();
    ok('planner: each unit\'s earliest week follows its own date', unitOf(snap, O.lines[0].unitKey).material.earliest === WEEK(D(8)) && unitOf(snap, O.lines[1].unitKey).material.earliest === WEEK(D(29)),
      j([unitOf(snap, O.lines[0].unitKey).material.earliest, unitOf(snap, O.lines[1].unitKey).material.earliest]));
    const e = await refusal(() => place(O.lines[1].unitKey, WEEK(D(8))));
    ok('planner REFUSES the late unit in the early unit\'s week (422 MATERIAL_NOT_READY), naming order, item, PO and date', e?.status === 422 && e.code === 'MATERIAL_NOT_READY'
      && e.problems[0].includes(O.code) && e.problems[0].includes(`${tag}-S3Q`) && e.problems[0].includes(po.code), e?.problems?.[0] ?? e?.message);
    says(e?.problems?.[0]);
    ok('…and accepts the early unit there, and the late one in its own week', !!(await place(O.lines[0].unitKey, WEEK(D(8)))).entries[O.lines[0].unitKey] && !!(await place(O.lines[1].unitKey, WEEK(D(29)))).entries[O.lines[1].unitKey]);
    ok('requisitions: both covered, on order', (await prOf(O.id, O.lines[0].id)).status === 'covered' && (await prOf(O.id, O.lines[1].id)).status === 'covered');
    // The edit itself says what it did to the plan (no planner read needed after it).
    const lineP2 = po.lines.find((l) => l.item.id === P2).id;
    const same = await PS.updatePurchaseLine(db, c, lineP2, { note: 'only a note' });
    ok('a PO line edit that moves neither date nor quantity carries no plannedUnits', same.plannedUnits === undefined);
    const cutQ = await H.measured(db, (q) => PS.updatePurchaseLine(q, c, lineP2, { quantity: 0.5 }));
    const pu = cutQ.result.plannedUnits;
    ok('REDUCING a PO line\'s quantity returns the planned unit it leaves WAITING: unit, order, line, its week, what it was', pu?.waiting === 1 && pu.late === 0 && pu.units.length === 1 && pu.units[0].unitKey === O.lines[1].unitKey
      && pu.units[0].order.code === O.code && pu.units[0].line.id === O.lines[1].id && pu.units[0].week === WEEK(D(29)) && pu.units[0].wasDate === D(29) && pu.units[0].kind === 'waiting'
      && pu.change.quantity.from === 1 && pu.change.quantity.to === 0.5 && j(pu.orderIds) === j([O.id]), j(pu));
    const snapAll = await H.measured(db, (q) => PL.getPlanner(q, COMPANY, { from: '2026-10-01' }));
    ok(`…for the orders the line is bought for only: ${cutQ.queries} round trips for the whole edit, a planner read alone is ${snapAll.queries}`, cutQ.queries < snapAll.queries, `${cutQ.queries} vs ${snapAll.queries}`);
    const gone = await PS.cancelPurchaseOrder(db, c, po.id, { reason: 'test' });
    ok('CANCELLING the PO returns both planned units, now waiting', gone.status === 'cancelled' && gone.plannedUnits.waiting === 2 && gone.plannedUnits.change.cancelled === true
      && j(gone.plannedUnits.units.map((u) => u.unitKey).sort()) === j(O.lines.map((l) => l.unitKey).sort()), j(gone.plannedUnits));
  }

  /* ============================================================================================ */
  if (run(5)) {
    section('5. Partial receipt');
    const M = await F.item('S5M');
    const O = await F.order('O5', [[[M, 5]], [[M, 5]]]);
    const r = await RQ.raiseRequisitions(db, c, O.id, {});
    const [x, y] = [r.requisitions.find((q) => q.line.id === O.lines[0].id), r.requisitions.find((q) => q.line.id === O.lines[1].id)];
    const made = await buy([[prLine(x, M).id, 5, D(10)], [prLine(y, M).id, 5, D(10)]]);
    const pol = made.purchaseOrders[0].lines[0];
    ok('before any receipt both units are dated', (await lineState(O.lines[0].id)).state === 'dated' && (await lineState(O.lines[1].id)).readyDate === D(10));
    const got = await PS.receiveLine(db, c, pol.id, { quantity: 5, stockingAreaId: F.store });
    ok('5 of 10 received: the share is HELD for the first requisition line', got.held.length === 1 && got.held[0].quantity === 5 && got.held[0].prLineId === prLine(x, M).id, j(got.held));
    const a = await lineState(O.lines[0].id); const b = await lineState(O.lines[1].id);
    ok('the unit it covers is READY today', a.state === 'ready' && reasonOf(a, M).cover[0].kind === 'held', j([a.state, a.readyDate]));
    ok('the rest keeps the PO date', b.state === 'dated' && b.readyDate === D(10), j([b.state, b.readyDate]));
    const pr = await prOf(O.id, O.lines[0].id);
    ok('requisition line 1 is "from stock" now (held 5); line 2 still on order', prLine(pr, M).status === 'from_stock' && prLine(pr, M).cover.held === 5 && prLine(await prOf(O.id, O.lines[1].id), M).status === 'covered');
    ok('the held stock is free for nobody else', (await availability(db, COMPANY, [M])).get(M).free === 0);
    const snap = await snapshot();
    ok('planner: unit 1 any week, unit 2 not before its week', unitOf(snap, O.lines[0].unitKey).material.earliest === null && unitOf(snap, O.lines[1].unitKey).material.earliest === WEEK(D(10)));
    const over = await refusal(() => PS.receiveLine(db, c, pol.id, { quantity: 6, stockingAreaId: F.store }));
    ok('over-receipt is refused, as before', !!over && /Only 5/.test(JSON.stringify(over.problems ?? over.message)), over?.message);
    const e = await refusal(() => place(O.lines[1].unitKey, TODAY));
    ok('planner refuses unit 2 this week', e?.code === 'MATERIAL_NOT_READY', e?.message);
    const last = await PS.receiveLine(db, c, pol.id, { quantity: 5, stockingAreaId: F.store });
    ok('the rest received: unit 2 is ready and can be placed this week', (await lineState(O.lines[1].id)).state === 'ready' && !!(await place(O.lines[1].unitKey, TODAY)).entries[O.lines[1].unitKey]);

    section('5b. A receipt REVERSED');
    const rev = await ST.reverseMovement(db, c, last.movement.id, { reason: 'wrong delivery note' });
    const [[pl]] = await db.query('SELECT qty_received FROM cf_purchase_order_lines WHERE id = ?', [pol.id]);
    const [shares] = await db.query('SELECT pr_line_id, qty_received FROM cf_purchase_line_orders WHERE purchase_line_id = ? AND deleted_at IS NULL ORDER BY id', [pol.id]);
    ok('the reversal lets the hold share go and puts the received quantity back: line 10 → 5, the second share 5 → 0', Number(pl.qty_received) === 5 && j(shares.map((x) => Number(x.qty_received))) === j([5, 0])
      && rev.purchase.released.length === 1 && rev.purchase.released[0].quantity === 5 && rev.purchase.released[0].prLineId === prLine(y, M).id, j([pl, shares, rev.purchase?.released]));
    ok('the purchase order is "part received" again', (await PS.getPurchaseOrder(db, COMPANY, made.purchaseOrders[0].id)).status === 'partially_received');
    const pr2 = await prOf(O.id, O.lines[1].id);
    ok('the requisition line\'s cover is open to the PO again: 5 on order, nothing held', prLine(pr2, M).cover.held === 0 && prLine(pr2, M).cover.ordered === 5 && prLine(pr2, M).status === 'covered', j(prLine(pr2, M).cover));
    const b2 = await lineState(O.lines[1].id);
    ok(`the engine is back on the PO date (${D(10)}); unit 1 keeps its own hold and stays ready`, b2.state === 'dated' && b2.readyDate === D(10) && (await lineState(O.lines[0].id)).state === 'ready', j([b2.state, b2.readyDate]));
    ok('the reversal itself reports the planned card it made late', rev.purchase.plannedUnits.late === 1 && rev.purchase.plannedUnits.units[0].unitKey === O.lines[1].unitKey && rev.purchase.plannedUnits.units[0].wasState === 'ready'
      && rev.purchase.plannedUnits.units[0].readyDate === D(10), j(rev.purchase.plannedUnits));
    ok('nothing is left reserved for stock that is gone', (await availability(db, COMPANY, [M])).get(M).available === 5 && (await availability(db, COMPANY, [M])).get(M).free === 0);
    // Reserved to a requirement: the first receipt cannot be reversed, and the sentence names the production order.
    await REL.reserveRelease(db, c, O.lines[0].releaseId);
    const held = await refusal(() => ST.reverseMovement(db, c, got.movement.id, { reason: 'try' }));
    ok('a receipt whose stock is RESERVED for production is refused, naming the order and line', held?.code === 'RESERVED' && held.message.includes(O.code) && /reserved for production/.test(held.message), held?.message);
    says(held?.message);
    const [[plAfter]] = await db.query('SELECT qty_received FROM cf_purchase_order_lines WHERE id = ?', [pol.id]);
    ok('…and nothing changed', Number(plAfter.qty_received) === 5);
  }

  /* ============================================================================================ */
  let skipCase = null;
  if (run(6) || run(7) || run(8)) {
    section('6. Buying SKIPPED — per material, and for all');
    const A = await F.item('S6A'); const B = await F.item('S6B');
    const O = await F.order('O6', [[[A, 5]]]);
    const O2 = await F.order('O6B', [[[A, 2], [B, 3]]]);
    let pr = (await RQ.raiseRequisitions(db, c, O.id, {})).requisitions[0];
    ok('nothing in stock, nothing decided: the unit WAITS', pr.materialReady.state === 'waiting' && pr.status === 'open');
    const none = await refusal(() => RQ.setSkip(db, c, pr.id, {}, true));
    ok('a skip must say which materials', none?.status === 422);
    const sk = await RQ.setSkip(db, c, pr.id, { lineIds: [prLine(pr, A).id], note: 'client supplies it later' }, true);
    pr = sk.requisition;
    ok('skip one material: recorded with who, when and the note', sk.changed === 1 && prLine(pr, A).skipped?.by?.id === user.id && !!prLine(pr, A).skipped.at && prLine(pr, A).skipped.note === 'client supplies it later', j(prLine(pr, A).skipped));
    ok('the line is "skipped", the requisition "skipped", and it counts as decided', prLine(pr, A).status === 'skipped' && pr.status === 'skipped' && pr.done === true, pr.status);
    says(pr.sentence);
    let res = await lineState(O.line.id);
    ok('engine: WAITING, with no date — "buying was skipped, waiting for stock"', res.state === 'waiting' && res.readyDate === null && /buying was skipped/.test(reasonOf(res, A).text) && reasonOf(res, A).skipped === true, res.text);
    let e = await refusal(() => place(O.line.unitKey, WEEK(D(20))));
    ok('planner REFUSES to place it anywhere — it is waiting', e?.code === 'MATERIAL_NOT_READY' && e.detail.units[0].kind === 'waiting' && /waiting for material/.test(e.problems[0]), e?.problems?.[0]);
    says(e?.problems?.[0]);
    let st = await buyingStage(O.id, O.line.id);
    ok('Buying is DONE and says "1 skipped (1 waiting for stock)"', st.state === 'done' && /1 skipped \(1 waiting for stock\)/.test(st.detail) && st.summary.skipped === 1 && st.summary.waiting === 1, st.detail);
    says(st.detail);
    const boardW = (await RQ.buyingBoard(db, COMPANY, { orderId: O.id })).waitingForStock;
    ok('the board\'s "Waiting for stock" group (from the server) holds the card, with the material and how much is short', boardW.key === 'waiting_for_stock' && boardW.count === 1 && boardW.cards[0].id === pr.id
      && boardW.cards[0].status === 'skipped' && boardW.cards[0].waitingLines[0].item.id === A && boardW.cards[0].waitingLines[0].short === 5, j(boardW));
    let pr2 = (await RQ.raiseRequisitions(db, c, O2.id, {})).requisitions[0];
    const all = await RQ.setSkip(db, c, pr2.id, { all: true }, true);
    pr2 = all.requisition;
    ok('SKIP ALL: every open material of the requisition in one call', all.changed === 2 && pr2.lines.every((l) => l.status === 'skipped') && pr2.status === 'skipped');
    const un = await RQ.setSkip(db, c, pr2.id, { lineIds: [prLine(pr2, B).id] }, false);
    ok('un-skip one: it is open again; the requisition is partly decided', un.changed === 1 && prLine(un.requisition, B).status === 'open' && prLine(un.requisition, B).skipped === null && un.requisition.status === 'partly_covered', un.requisition.status);
    skipCase = { A, B, O, O2, pr };
  }

  if (skipCase && (run(7) || run(8))) {
    const { A, O } = skipCase;
    section('7. …stock is ADDED (a plain receipt, no order named)');
    const heldBefore = await activeHolds(A);
    await F.receive(A, 5);
    const res = await lineState(O.line.id);
    ok('the very next read: the unit is plannable NOW (ready, soft)', res.state === 'ready' && res.soft === true && reasonOf(res, A).cover[0].kind === 'free', j([res.state, res.soft]));
    const heldAfter = await activeHolds(A);
    ok('NOTHING is earmarked: no reservation or hold was written', Number(heldAfter.n) === Number(heldBefore.n) && (await availability(db, COMPANY, [A])).get(A).free === 5);
    const w = await place(O.line.unitKey, WEEK(D(7)));
    ok('planner accepts the placement at once', w.entries[O.line.unitKey]?.shipDate === WEEK(D(7)));
    ok('…and it has left the board\'s "Waiting for stock" group', (await RQ.buyingBoard(db, COMPANY, { orderId: O.id })).waitingForStock.count === 0);
    const st = await buyingStage(O.id, O.line.id);
    ok('Buying now says "1 skipped (in stock now)"', st.state === 'done' && /1 skipped \(in stock now\)/.test(st.detail), st.detail);
    const pr = await prOf(O.id);
    ok('the requisition line stays "skipped" and says the stock is there', prLine(pr, A).status === 'skipped' && /in stock now/.test(prLine(pr, A).sentence) && prLine(pr, A).cover.freeNow === 5, prLine(pr, A).sentence);

    if (run(8)) {
      section('8. …that stock is then HELD / RESERVED for another order');
      const X = await F.order('O8', [[[A, 5]]]);
      const prX = (await RQ.raiseRequisitions(db, c, X.id, {})).requisitions[0];
      // X is ranked BEHIND O (a later order): it does not win the free stock by itself…
      ok('before any earmark the first order still has it (it is ahead in claim order)', (await lineState(O.line.id)).state === 'ready' && (await lineState(X.line.id)).state === 'waiting');
      // …until its stock check earmarks it.
      const held = await RQ.stockCheck(db, c, prX.id, { apply: true });
      ok('the other order\'s stock check holds the 5', held.held.length === 1 && held.held[0].quantity === 5);
      let res2 = await lineState(O.line.id);
      ok('the first unit is WAITING again', res2.state === 'waiting' && res2.readyDate === null, res2.text);
      let snap = await snapshot();
      const b = snap.entries[O.line.unitKey]?.blocked;
      ok('planner: its stored placement is REPORTED blocked (kind waiting), not moved', b?.kind === 'waiting' && snap.entries[O.line.unitKey].shipDate === WEEK(D(7)) && b.was.state === 'ready', j(snap.entries[O.line.unitKey]));
      says(b?.message);
      ok('…and counted', snap.materialReady.blockedEntries >= 1);
      const e = await refusal(() => place(O.line.unitKey, WEEK(D(14))));
      ok('planner refuses to MOVE it anywhere while it waits', e?.code === 'MATERIAL_NOT_READY');
      const [[h]] = await db.query("SELECT id FROM cf_stock_reservations WHERE company_id = ? AND pr_line_id = ? AND status = 'active'", [COMPANY, prLine(held.requisition, A).id]);
      await releaseHold(db, c, h.id);
      res2 = await lineState(O.line.id);
      snap = await snapshot();
      ok('release that hold → plannable again, and the block is gone', res2.state === 'ready' && !snap.entries[O.line.unitKey]?.blocked, j([res2.state, snap.entries[O.line.unitKey]]));
      // The same with a RELEASE RESERVATION instead of a hold.
      const rv = await REL.reserveRelease(db, c, X.line.releaseId);
      ok('reserved for the other order\'s released line instead: waiting again', rv.short.length === 0 && (await lineState(O.line.id)).state === 'waiting');
      const [[v]] = await db.query("SELECT v.id FROM cf_stock_reservations v JOIN cf_material_requirements q ON q.id = v.requirement_id WHERE q.release_id = ? AND v.status = 'active'", [X.line.releaseId]);
      await REL.releaseReservation(db, c, v.id);
      ok('reservation let go → plannable again', (await lineState(O.line.id)).state === 'ready');
    }
  }

  /* ============================================================================================ */
  if (run(9)) {
    section('9. Two skipped orders compete for stock that covers only one');
    const Dm = await F.item('S9D');
    const P1 = await F.order('O9A', [[[Dm, 5]]]);
    const P2 = await F.order('O9B', [[[Dm, 5]]]);
    for (const o of [P1, P2]) { const pr = (await RQ.raiseRequisitions(db, c, o.id, {})).requisitions[0]; await RQ.setSkip(db, c, pr.id, { all: true }, true); }
    await F.receive(Dm, 5);
    await PL.putPriorities(db, c, { orderIds: [P1.id, P2.id] });
    let a = await lineState(P1.line.id); let b = await lineState(P2.line.id);
    ok('priority 1 wins the stock; the other waits', a.state === 'ready' && b.state === 'waiting', j([a.state, b.state]));
    let snap = await snapshot();
    ok('planner agrees unit for unit', unitOf(snap, P1.line.unitKey).material.state === 'ready' && unitOf(snap, P2.line.unitKey).material.state === 'waiting');
    // An auto-placed card (not pinned) claims in the ranking's order.
    ok('…and refuses the loser, accepts the winner (auto-placed cards: the ranking decides)', (await refusal(() => place(P2.line.unitKey, TODAY, { pinned: false })))?.code === 'MATERIAL_NOT_READY'
      && !!(await place(P1.line.unitKey, TODAY, { pinned: false })).entries[P1.line.unitKey]);
    await unplace(P1.line.unitKey);
    const twice = [await lineState(P1.line.id), await lineState(P1.line.id)].map((x) => x.state).join();
    ok('the answer is the same every time it is asked (deterministic)', twice === 'ready,ready');
    await PL.putPriorities(db, c, { orderIds: [P2.id, P1.id] });
    a = await lineState(P1.line.id); b = await lineState(P2.line.id);
    ok('swap the priorities → it flips', a.state === 'waiting' && b.state === 'ready', j([a.state, b.state]));
    // A card PINNED by hand claims before the ranking — the planner's documented claim order (pins, then priority).
    await PL.putPriorities(db, c, { orderIds: [P1.id, P2.id] });
    const pinned = await place(P2.line.unitKey, WEEK(D(7)), { pinned: true });
    snap = await snapshot();
    ok('a card pinned by hand claims first, whatever the ranking: the save is checked for the plan AS SAVED', pinned.entries[P2.line.unitKey]?.pinned === true
      && unitOf(snap, P2.line.unitKey).material.state === 'ready' && unitOf(snap, P1.line.unitKey).material.state === 'waiting',
      j([unitOf(snap, P1.line.unitKey).material.state, unitOf(snap, P2.line.unitKey).material.state]));
    await unplace(P2.line.unitKey);
    snap = await snapshot();
    ok('unpinned again, the ranking decides again', unitOf(snap, P1.line.unitKey).material.state === 'ready' && unitOf(snap, P2.line.unitKey).material.state === 'waiting');
  }

  /* ============================================================================================ */
  if (run(10)) {
    section('10. EARMARK INVISIBILITY — stock earmarked for A is invisible to B, reader by reader');
    const check = async (label, item, Aord, Bord, qtyHeld) => {
      const prB = await prOf(Bord.id);
      const dryB = await RQ.stockCheck(db, c, prB.id, {});
      ok(`${label} · B's requisition availability: 0 free now`, prLine(prB, item).cover.freeNow === 0 && prLine(prB, item).ready.state === 'waiting', j(prLine(prB, item).cover));
      ok(`${label} · B's stock check: 0 free, proposes nothing`, dryB.lines[0].freeInStock === 0 && dryB.canApply === false, j(dryB.lines));
      const e = await refusal(() => RQ.stockCheck(db, c, prB.id, { apply: true, lines: [{ lineId: prLine(prB, item).id, hold: 1 }] }));
      ok(`${label} · B cannot hold it by asking either`, !!e && /only 0 .*is free in stock/.test(JSON.stringify(e.problems)), j(e?.problems));
      const board = await RQ.buyingBoard(db, COMPANY, { orderId: Bord.id });
      const cardB = board.columns.flatMap((x) => x.cards).find((x) => x.order.id === Bord.id);
      ok(`${label} · Buying board: B's card is waiting`, cardB?.materialReady.state === 'waiting', j(cardB?.materialReady));
      const rows = await PS.buyList(db, COMPANY, { show: 'all', search: tag });
      const row = rows.find((x) => x.item.id === item && !x.planned);
      ok(`${label} · buy list: none of it is free; B still has to buy`, row.free === 0 && row.split.some((s) => s.orderId === Bord.id && s.toBuy > 0) && !row.split.some((s) => s.orderId === Aord.id), j([row.free, row.split]));
      const snap = await snapshot();
      ok(`${label} · planner: B's unit waits; A's is ready`, unitOf(snap, Bord.line.unitKey).material.state === 'waiting' && unitOf(snap, Aord.line.unitKey).material.state === 'ready',
        j([unitOf(snap, Aord.line.unitKey).material.state, unitOf(snap, Bord.line.unitKey).material.state]));
      ok(`${label} · general availability: 0 free; for A's own order: its ${qtyHeld}`, (await availability(db, COMPANY, [item])).get(item).free === 0);
      const prA = await prOf(Aord.id);
      ok(`${label} · A still sees its own: covered, ${qtyHeld} here`, prLine(prA, item).cover.stock === qtyHeld && prLine(prA, item).status === 'from_stock', j(prLine(prA, item).cover));
    };
    // (a) by the stock check
    { const it = await F.item('S10A'); await F.receive(it, 4);
      const Ao = await F.order('O10A', [[[it, 4]]]); const Bo = await F.order('O10B', [[[it, 4]]]);
      const prA = (await RQ.raiseRequisitions(db, c, Ao.id, {})).requisitions[0]; await RQ.raiseRequisitions(db, c, Bo.id, {});
      await RQ.stockCheck(db, c, prA.id, { apply: true });
      await check('held by STOCK CHECK', it, Ao, Bo, 4); }
    // (b) by a receipt on A's purchase order
    { const it = await F.item('S10B');
      const Ao = await F.order('O10C', [[[it, 4]]]); const Bo = await F.order('O10D', [[[it, 4]]]);
      const prA = (await RQ.raiseRequisitions(db, c, Ao.id, {})).requisitions[0]; await RQ.raiseRequisitions(db, c, Bo.id, {});
      const made = await buy([[prLine(prA, it).id, 4, D(5)]]);
      await PS.receiveLine(db, c, made.purchaseOrders[0].lines[0].id, { quantity: 4, stockingAreaId: F.store });
      await check('held by RECEIPT on A\'s PO', it, Ao, Bo, 4); }
    // (c) by a release reservation
    { const it = await F.item('S10C'); await F.receive(it, 4);
      const Ao = await F.order('O10E', [[[it, 4]]]); const Bo = await F.order('O10F', [[[it, 4]]]);
      await RQ.raiseRequisitions(db, c, Ao.id, {}); await RQ.raiseRequisitions(db, c, Bo.id, {});
      await REL.reserveRelease(db, c, Ao.line.releaseId);
      await check('RESERVED for A\'s released line', it, Ao, Bo, 4); }
  }

  /* ============================================================================================ */
  if (run(11)) {
    section('11. Order A\'s PO never feeds order B; an UNALLOCATED PO line is pooled');
    const G = await F.item('S11G');
    const Ao = await F.order('O11A', [[[G, 5]]], { committed: '2099-01-01' });
    const Bo = await F.order('O11B', [[[G, 5]]], { committed: '2098-01-01' });   // B is AHEAD in claim order (earlier committed date)
    const prA = (await RQ.raiseRequisitions(db, c, Ao.id, {})).requisitions[0];
    await RQ.raiseRequisitions(db, c, Bo.id, {});
    const made = await buy([[prLine(prA, G).id, 5, D(6)]]);
    let a = await lineState(Ao.line.id); let b = await lineState(Bo.line.id);
    ok('A is dated by its own PO', a.state === 'dated' && a.readyDate === D(6) && reasonOf(a, G).cover[0].poCode === made.purchaseOrders[0].code);
    ok('B — though ahead in claim order — gets NOTHING of A\'s PO: it waits', b.state === 'waiting' && reasonOf(b, G).short === 5, b.text);
    says(b.text);
    let snap = await snapshot();
    ok('planner: B waits, A is dated; the old pooled `supply` field is still there for the old browser', unitOf(snap, Bo.line.unitKey).material.state === 'waiting' && unitOf(snap, Ao.line.unitKey).material.earliest === WEEK(D(6)) && typeof snap.supply === 'object');
    let po = await PS.createPurchaseOrder(db, c, { supplierId: F.S2, expectedDate: D(12) });
    po = await PS.addPurchaseLine(db, c, po.id, { itemId: G, quantity: 5, orderId: null });
    b = await lineState(Bo.line.id);
    ok('an unallocated line on a REQUESTED PO is not supply (no date yet)', b.state === 'waiting');
    await PS.markOrdered(db, c, po.id, {});
    b = await lineState(Bo.line.id);
    ok(`placed: the unallocated line is POOLED — B takes it, dated ${D(12)}`, b.state === 'dated' && b.readyDate === D(12) && reasonOf(b, G).cover[0].pooled === true && reasonOf(b, G).cover[0].poCode === po.code, j([b.state, b.readyDate, reasonOf(b, G).cover]));
    says(reasonOf(b, G).text);
    a = await lineState(Ao.line.id);
    ok('A is unchanged — its own PO, its own date', a.readyDate === D(6));
    const prB = await prOf(Bo.id);
    ok('B\'s requisition line is still OPEN (nothing is bought FOR it) and says what is pooled', prLine(prB, G).status === 'open' && prLine(prB, G).cover.pooledOnOrder === 5, j(prLine(prB, G).cover));
    const Co = await F.order('O11C', [[[G, 5]]], { committed: '2099-06-01' });
    ok('a third order behind them finds the pooled line taken: it waits', (await lineState(Co.line.id)).state === 'waiting');
  }

  /* ============================================================================================ */
  if (run(12) || run(13)) {
    section('12. Requested / quoting POs give "waiting — asked for, no date yet"');
    const Hh = await F.item('S12H'); const Ii = await F.item('S12I');
    const O = await F.order('O12', [[[Hh, 6], [Ii, 2]]]);
    let pr = (await RQ.raiseRequisitions(db, c, O.id, {})).requisitions[0];
    const made = await RQ.makePurchaseOrders(db, c, { orders: [{ lines: [{ prLineId: prLine(pr, Hh).id }, { prLineId: prLine(pr, Ii).id }] }] });
    const po = made.purchaseOrders[0];
    ok('a PO made without placing is REQUESTED, lines = what is open, linked to the requisition lines', po.status === 'requested' && po.supplier === null
      && j(po.lines.map((l) => [l.item.id, l.quantity, l.for[0].prLineId]).sort()) === j([[Hh, 6, prLine(pr, Hh).id], [Ii, 2, prLine(pr, Ii).id]].sort()), j(po.lines));
    pr = made.requisitions[0];
    ok('requisition: both lines "asked", not resolved; status partly covered', pr.lines.every((l) => l.status === 'asked' && !l.resolved) && pr.status === 'partly_covered' && pr.done === false, pr.status);
    let res = await lineState(O.line.id);
    ok('engine: WAITING — asked for, no date yet', res.state === 'waiting' && /asked for on .* not ordered yet — no date/.test(res.text), res.text);
    says(res.text);
    ok('planner refuses to place it', (await refusal(() => place(O.line.unitKey, WEEK(D(40)))))?.code === 'MATERIAL_NOT_READY');
    let st = await buyingStage(O.id, O.line.id);
    ok('Buying is NOT done: "asked for, not ordered with a date"', st.state === 'todo' && /asked for, not ordered with a date/.test(st.detail), st.detail);
    const over = await refusal(() => RQ.makePurchaseOrders(db, c, { orders: [{ lines: [{ prLineId: prLine(pr, Hh).id, quantity: 1 }] }] }));
    ok('buying more than is open is refused, naming order and item', !!over && over.problems.some((p) => p.includes(O.code) && p.includes(`${tag}-S12H`) && /only 0/.test(p)), j(over?.problems));
    await PF.sendRfq(db, c, po.id, { supplierIds: [F.S1, F.S2] });
    res = await lineState(O.line.id);
    ok('quoting: still waiting', res.state === 'waiting' && (await prOf(O.id)).lines.every((l) => l.status === 'asked'));

    if (run(13)) {
      section('13. RFQ → quotes → place, split over two suppliers: requisition links and per-line dates survive');
      const q0 = await PF.poQuotes(db, c, po.id);
      const rl = (item) => q0.rfq.lines.find((l) => (l.item?.id ?? l.itemId) === item).id;
      await PF.recordQuote(db, c, po.id, { supplierId: F.S1, lines: [{ rfqLineId: rl(Hh), unitPrice: 100, leadTimeDays: 5 }, { rfqLineId: rl(Ii), unitPrice: 55, leadTimeDays: 9 }] });
      const q2 = await PF.recordQuote(db, c, po.id, { supplierId: F.S2, lines: [{ rfqLineId: rl(Hh), unitPrice: 120, leadTimeDays: 3 }, { rfqLineId: rl(Ii), unitPrice: 50, leadTimeDays: 20 }] });
      const quoteLine = (supplierId, item) => q2.rfq.quotes.find((q) => (q.supplier?.id ?? q.supplierId) === supplierId).lines.find((l) => l.rfqLineId === rl(item)).id;
      const placed = await PF.placeOrder(db, c, po.id, { awards: [{ rfqLineId: rl(Hh), quoteLineId: quoteLine(F.S1, Hh) }, { rfqLineId: rl(Ii), quoteLineId: quoteLine(F.S2, Ii) }] });
      ok('two ordered POs, one per supplier', placed.purchaseOrders.length === 2 && placed.purchaseOrders.every((p) => p.status === 'ordered'));
      const lh = placed.purchaseOrders.flatMap((p) => p.lines).find((l) => l.item.id === Hh);
      const li = placed.purchaseOrders.flatMap((p) => p.lines).find((l) => l.item.id === Ii);
      ok('each PO line KEEPS its requisition line', lh.orders[0].prLineId === prLine(pr, Hh).id && li.orders[0].prLineId === prLine(pr, Ii).id && lh.orders[0].requisition.code === pr.code, j([lh.orders, li.orders]));
      const dH = MR.dateOnly(lh.expectedDate); const dI = MR.dateOnly(li.expectedDate);
      ok('…and has its OWN date (from its lead time)', !!dH && !!dI && dH !== dI, j([dH, dI]));
      res = await lineState(O.line.id);
      ok('engine: DATED, by the later of the two lines', res.state === 'dated' && res.readyDate === (dH > dI ? dH : dI) && reasonOf(res, Hh).date === dH && reasonOf(res, Ii).date === dI, j([res.state, res.readyDate, dH, dI]));
      pr = await prOf(O.id);
      ok('requisition: covered; each line shows its PO, supplier and date', pr.status === 'covered' && prLine(pr, Hh).purchase[0].supplier.id === F.S1 && prLine(pr, Ii).purchase[0].supplier.id === F.S2
        && prLine(pr, Hh).purchase[0].date === dH && prLine(pr, Ii).cover.lastDate === dI, j(pr.lines.map((l) => l.purchase)));
      st = await buyingStage(O.id, O.line.id);
      ok('Buying is DONE: 2 on order, with the last delivery', st.state === 'done' && /2 on order, last delivery/.test(st.detail), st.detail);
      says(st.detail);
      const later = res.readyDate;
      ok('planner: refused before its week, accepted in it', (await refusal(() => place(O.line.unitKey, TODAY)))?.code === 'MATERIAL_NOT_READY' && !!(await place(O.line.unitKey, WEEK(later))).entries[O.line.unitKey]);
    }
  }

  /* ============================================================================================ */
  if (run(14)) {
    section('14. A mixed line: one material from stock, one on a PO, one skipped');
    const Jj = await F.item('S14J'); const K = await F.item('S14K'); const L = await F.item('S14L');
    await F.receive(Jj, 3);
    const O = await F.order('O14', [[[Jj, 3], [K, 4], [L, 2]]]);
    let pr = (await RQ.raiseRequisitions(db, c, O.id, {})).requisitions[0];
    const one = await RQ.stockCheck(db, c, pr.id, { lineIds: [prLine(pr, Jj).id] });
    ok('the stock check DRY RUN for ONE requisition line (lineIds) answers that row only', one.applied === false && one.lines.length === 1 && one.lines[0].lineId === prLine(pr, Jj).id && one.lines[0].proposeHold === 3, j(one.lines));
    const bad = await refusal(() => RQ.stockCheck(db, c, pr.id, { lineIds: [999999999] }));
    ok('…a line id that is not on the requisition is refused', bad?.status === 422);
    const applied = await RQ.stockCheck(db, c, pr.id, { apply: true, lineIds: [prLine(pr, Jj).id] });
    ok('…and APPLY with lineIds holds that row only', applied.held.length === 1 && applied.held[0].lineId === prLine(pr, Jj).id);
    await buy([[prLine(pr, K).id, 4, D(15)]]);
    pr = (await RQ.setSkip(db, c, pr.id, { lineIds: [prLine(pr, L).id] }, true)).requisition;
    ok('line statuses: from_stock, covered, skipped', j([prLine(pr, Jj).status, prLine(pr, K).status, prLine(pr, L).status]) === j(['from_stock', 'covered', 'skipped']), j(pr.lines.map((l) => l.status)));
    ok('requisition status "mixed" — every material decided, one skipped — and done', pr.status === 'mixed' && pr.done === true, pr.status);
    says(pr.sentence);
    let res = await lineState(O.line.id);
    ok('engine: WAITING (the skipped one has no stock) — and each material says why', res.state === 'waiting' && reasonOf(res, Jj).state === 'ready' && reasonOf(res, Jj).cover[0].kind === 'held'
      && reasonOf(res, K).state === 'dated' && reasonOf(res, K).date === D(15) && reasonOf(res, L).state === 'waiting' && reasonOf(res, L).skipped, j(res.reasons.map((r) => [r.state, r.date])));
    const snap = await snapshot();
    const u = unitOf(snap, O.line.unitKey);
    ok('planner unit: waiting; its reasons list the dated and the waiting material, not the one that is simply here', u.material.state === 'waiting' && u.material.materials === 3 && u.material.reasons.length === 2, j(u.material.reasons.map((r) => r.state)));
    const st = await buyingStage(O.id, O.line.id);
    ok('Buying is done: "1 held in stock, 1 on order …, 1 skipped (1 waiting for stock)"', st.state === 'done' && /1 held in stock, 1 on order.*1 skipped \(1 waiting for stock\)/.test(st.detail), st.detail);
    says(st.detail);
    await F.receive(L, 2);
    res = await lineState(O.line.id);
    ok(`stock for the skipped one arrives → DATED ${D(15)} (the PO), soft`, res.state === 'dated' && res.readyDate === D(15) && res.soft === true, j([res.state, res.readyDate]));
    ok('planner: refused this week, accepted from its week', (await refusal(() => place(O.line.unitKey, TODAY)))?.code === 'MATERIAL_NOT_READY' && !!(await place(O.line.unitKey, WEEK(D(15)))).entries[O.line.unitKey]);
  }

  /* ============================================================================================ */
  if (run(17)) {
    section('17. Customer-owned stock only serves that customer\'s order');
    const N = await F.item('S17N');
    const Mine = await F.order('O17A', [[[N, 3]]], { customer: F.CUS2, committed: '2099-06-01' });
    const Other = await F.order('O17B', [[[N, 3]]], { customer: F.CUS, committed: '2098-01-01' });   // ahead in claim order
    await OWN.receiveCustomerMaterial(db, c, { orderId: Mine.id, toAreaId: F.store, lines: [{ itemId: N, quantity: 3 }] });
    const prM = (await RQ.raiseRequisitions(db, c, Mine.id, {})).requisitions[0];
    const prO = (await RQ.raiseRequisitions(db, c, Other.id, {})).requisitions[0];
    const m = await lineState(Mine.line.id); const o = await lineState(Other.line.id);
    ok('the owner\'s order can use it (free, the customer\'s own)', m.state === 'ready' && reasonOf(m, N).cover[0].kind === 'free' && reasonOf(m, N).cover[0].owner === 'customer', j(reasonOf(m, N).cover));
    ok('another customer\'s order cannot — though it is ahead in claim order', o.state === 'waiting' && reasonOf(o, N).short === 3);
    ok('stock check: free for the owner 3, for the other 0', (await RQ.stockCheck(db, c, prM.id, {})).lines[0].freeInStock === 3 && (await RQ.stockCheck(db, c, prO.id, {})).lines[0].freeInStock === 0);
    const snap = await snapshot();
    ok('planner agrees', unitOf(snap, Mine.line.unitKey).material.state === 'ready' && unitOf(snap, Other.line.unitKey).material.state === 'waiting');
    const held = await RQ.stockCheck(db, c, prM.id, { apply: true });
    const [[hb]] = await db.query("SELECT batch_id FROM cf_stock_reservations WHERE company_id = ? AND pr_line_id = ? AND status = 'active'", [COMPANY, prLine(held.requisition, N).id]);
    ok('holding it for the owner claims the customer\'s LOT', held.requisition.status === 'fulfilled_from_stock' && hb.batch_id != null);
  }

  /* ============================================================================================ */
  if (run(2) || run(4) || run(15) || run(16)) {
    const G = await girder(db, c, tag);
    const totals = (n) => ({ A: PER_GIRDER.A * n, B: PER_GIRDER.B * n, C: PER_GIRDER.C * n });

    let GA = null;
    let poB = null;
    if (run(2) || run(4) || run(15)) {
      section('2. One requisition split into THREE POs with different receiving dates (a frozen line of 3 girders = 3 plan units)');
      GA = await G.girderOrder('GA', 3);
      ok('the frozen line has 3 plan units, one per girder', GA.units.length === 3, j(GA.units));
      let pr = (await RQ.raiseRequisitions(db, c, GA.id, {})).requisitions[0];
      const t = totals(3);
      ok(`the requisition asks for the line's planned material: A ${t.A}, B ${t.B}, C ${t.C}`, prLine(pr, G.A).need === t.A && prLine(pr, G.B).need === t.B && prLine(pr, G.C).need === t.C && pr.line.frozen && !pr.line.released, j(pr.lines.map((l) => [l.item.code, l.need])));
      let snap = await snapshot();
      ok('planner: every unit waits (nothing decided)', GA.units.every((k) => unitOf(snap, k).material.state === 'waiting') && unitOf(snap, GA.lineKey).material.state === 'waiting');
      ok('…and each unit\'s need is its own girder\'s share', unitOf(snap, GA.units[0]).material.reasons.find((r) => r.item.id === G.A).need === PER_GIRDER.A);
      // A: three POs, 4 each, three dates. B: one PO. C: from stock.
      const dA = [D(8), D(22), D(36)];
      for (const d of dA) await buy([[prLine(pr, G.A).id, PER_GIRDER.A, d]], { supplier: G.SUP });
      const madeB = await buy([[prLine(pr, G.B).id, t.B, D(15)]], { supplier: G.SUP });
      poB = madeB.purchaseOrders[0];
      await G.receive(G.C, t.C);
      await RQ.stockCheck(db, c, pr.id, { apply: true, lineIds: [prLine(pr, G.C).id] });
      pr = await prOf(GA.id);
      ok('requisition line A is covered by THREE POs, each its own quantity and date', prLine(pr, G.A).purchase.length === 3 && j(prLine(pr, G.A).purchase.map((p) => [p.quantity, p.date])) === j(dA.map((d) => [PER_GIRDER.A, d]))
        && prLine(pr, G.A).status === 'covered' && prLine(pr, G.A).cover.firstDate === dA[0] && prLine(pr, G.A).cover.lastDate === dA[2], j(prLine(pr, G.A).purchase.map((p) => [p.quantity, p.date])));
      ok('the requisition is covered', pr.status === 'covered' && pr.done, pr.status);
      snap = await snapshot();
      const m = GA.units.map((k) => unitOf(snap, k).material);
      // unit 1: A due D8, B due D15 → the LATER: D15. unit 2: A D22. unit 3: A D36.
      ok(`unit 1 needs two materials (A ${dA[0]}, B ${D(15)}) and takes the LATER date`, m[0].state === 'dated' && m[0].readyDate === D(15) && m[0].reasons.find((r) => r.item.id === G.A).date === dA[0], j([m[0].readyDate, m[0].reasons.map((r) => r.date)]));
      ok(`unit 2 is held until the second PO (${dA[1]}), unit 3 until the third (${dA[2]})`, m[1].readyDate === dA[1] && m[2].readyDate === dA[2], j(m.map((x) => x.readyDate)));
      ok('the same kilogram never makes two units ready: the three A covers are three different POs', new Set(m.map((x) => x.reasons.find((r) => r.item.id === G.A).cover[0].poCode)).size === 3);
      ok('C is held from stock — it is not among the reasons', m.every((x) => !x.reasons.some((r) => r.item.id === G.C)));
      const old = unitOf(snap, GA.units[0]).materials;
      ok('the OLD browser fields are still there — and a unit no longer asks the pooled supply for what is HELD for it (C)', old.some((x) => x.itemId === G.A && x.qty === PER_GIRDER.A) && !old.some((x) => x.itemId === G.C)
        && Array.isArray(snap.supply[G.A]?.lots) && snap.supply[G.A].lots.length === 3, j([old, snap.supply[G.A]]));
      ok('the whole line as one card: dated by the last PO', unitOf(snap, GA.lineKey).material.readyDate === dA[2]);
      const lineRes = await lineState(GA.lineId);
      ok('the line-level engine (Buying, requisition) says the same last date', lineRes.state === 'dated' && lineRes.readyDate === dA[2]);
      for (const [i, k] of GA.units.entries()) {
        const early = await refusal(() => place(k, TODAY));
        const w = await place(k, m[i].earliest);
        ok(`unit ${i + 1}: refused this week, accepted in the week of ${m[i].earliest}`, early?.code === 'MATERIAL_NOT_READY' && w.entries[k]?.shipDate === m[i].earliest, early?.message);
      }
      const e3 = await refusal(() => place(GA.units[2], m[1].earliest));
      ok('unit 3 is refused in unit 2\'s week — the message names the PO and the date', e3?.code === 'MATERIAL_NOT_READY' && e3.problems[0].includes(GA.code) && e3.problems[0].includes('PO-'), e3?.problems?.[0]);
      says(e3?.problems?.[0]);
      const stretch = await refusal(() => place(GA.units[1], WEEK(D(60)), { startDate: TODAY }));
      ok('a stretched bar may not START before its material either', stretch?.code === 'MATERIAL_NOT_READY' && /start in the week/.test(stretch.problems[0]), stretch?.problems?.[0]);

      if (run(4)) {
        section('4. A PO date moves later after the units were planned — and back');
        snap = await snapshot();
        ok('as planned: nothing is blocked', GA.units.every((k) => !snap.entries[k].blocked));
        const lineB = poB.lines[0];
        const edit = await PS.updatePurchaseLine(db, c, lineB.id, { expectedDate: D(50) });
        ok('the PUT itself returns the three planned units it made LATE: unit, order, line, week, old date → new date', edit.plannedUnits.late === 3 && edit.plannedUnits.waiting === 0
          && j(edit.plannedUnits.units.map((u) => u.unitKey).sort()) === j([...GA.units].sort()) && edit.plannedUnits.units.every((u) => u.order.code === GA.code && u.line.id === GA.lineId && u.readyDate === D(50) && u.earliest === WEEK(D(50)))
          && edit.plannedUnits.units.find((u) => u.unitKey === GA.units[0]).wasDate === D(15) && edit.plannedUnits.units.find((u) => u.unitKey === GA.units[0]).week === WEEK(D(15))
          && edit.plannedUnits.change.date.from === D(15) && edit.plannedUnits.change.date.to === D(50), j(edit.plannedUnits));
        snap = await snapshot();
        ok('…and it is exactly what the whole planner read reports', j(edit.plannedUnits.units.map((u) => [u.unitKey, u.kind, u.readyDate]).sort()) === j(GA.units.map((k) => [k, snap.entries[k].blocked.kind, snap.entries[k].blocked.readyDate]).sort()));
        const b1 = snap.entries[GA.units[0]].blocked;
        ok('unit 1\'s placement is reported MATERIAL_LATE with the old and the new date', b1?.kind === 'material_late' && b1.readyDate === D(50) && b1.was.date === D(15) && b1.earliest === WEEK(D(50)), j(b1));
        says(b1?.message);
        ok('units 2 and 3 (planned before day 50) are late too — B is in every girder', snap.entries[GA.units[1]].blocked?.kind === 'material_late' && snap.entries[GA.units[2]].blocked?.kind === 'material_late');
        ok('nothing was moved: the placements are where they were', snap.entries[GA.units[0]].shipDate === WEEK(D(15)));
        const stay = await PL.putEntries(db, c, { entries: [{ unitKey: GA.units[0], shipDate: snap.entries[GA.units[0]].shipDate, pinned: true }] });
        ok('re-saving a card where it stands is not refused — an old placement is flagged, not policed', stay.entries[GA.units[0]].shipDate === WEEK(D(15)));
        const moveEarly = await refusal(() => place(GA.units[0], WEEK(D(22))));
        ok('but MOVING it to another too-early week is refused', moveEarly?.code === 'MATERIAL_NOT_READY');
        const pr = await prOf(GA.id);
        ok('the requisition shows the new date at once', prLine(pr, G.B).cover.lastDate === D(50));
        const earlier = await PS.updatePurchaseLine(db, c, lineB.id, { expectedDate: D(6) });
        ok('moved earlier: the PUT returns no unit', earlier.plannedUnits.units.length === 0 && earlier.plannedUnits.late === 0);
        snap = await snapshot();
        ok('moved EARLIER: every block clears', GA.units.every((k) => !snap.entries[k].blocked), j(GA.units.map((k) => snap.entries[k].blocked?.kind)));
        ok('unit 1 is now dated by A alone', unitOf(snap, GA.units[0]).material.readyDate === D(8));
        // An overdue delivery: the date is kept and the state is 'late'.
        MR.setToday(D(9));
        snap = await snapshot();
        const late = unitOf(snap, GA.units[0]).material;
        ok('the day after A\'s first PO was due and nothing arrived: state LATE, date kept', late.state === 'late' && late.readyDate === D(9) && late.reasons.some((r) => r.cover.some((x) => x.late && x.date === D(8))), j([late.state, late.readyDate, late.text]));
        says(late.text);
        MR.setToday(TODAY);
        await PS.updatePurchaseLine(db, c, lineB.id, { expectedDate: D(15) });
      }
    }

    if (run(15) && GA) {
      section('15. A RELEASED line with material missing is blocked the same; its step will not start');
      const before15 = await snapshot();
      const was = GA.units.map((k) => [unitOf(before15, k).material.state, unitOf(before15, k).material.readyDate]);
      const check = await REL.releaseCheck(db, COMPANY, GA.lineId);
      ok('release is ALLOWED with material missing — and the preview says so', check.ok === true && check.materialReady.state === 'dated' && check.materialReady.readyDate === D(36) && check.materialReady.materials.length === 3, j([check.ok, check.problems, check.materialReady.state]));
      const rel = await REL.releaseLine(db, c, GA.lineId, { finishedAreaId: G.dispatch, view: 'none' });
      const releaseId = rel.id ?? (await REL.liveReleaseOfLine(db, COMPANY, GA.lineId)).id;
      const after15 = await snapshot();
      const now = GA.units.map((k) => [unitOf(after15, k).material.state, unitOf(after15, k).material.readyDate]);
      ok('planner: the released units carry the SAME states and dates as before the release', j(now) === j(was), j([was, now]));
      ok('the old browser fields: a released unit still lists no materials', unitOf(after15, GA.units[0]).materials.length === 0 && unitOf(before15, GA.units[0]).materials.length > 0);
      const e = await refusal(() => place(GA.units[2], TODAY));
      ok('planner refuses a released unit before its material, exactly like an unreleased one', e?.code === 'MATERIAL_NOT_READY', e?.message);
      const pr = await prOf(GA.id);
      ok('the requisition follows the release: same needs, now read from the requirements', pr.line.released && prLine(pr, G.A).need === 12 && pr.status === 'covered' && !pr.stale, j([pr.status, pr.stale]));
      const [[stepRow]] = await db.query('SELECT step_id FROM cf_material_requirements WHERE company_id = ? AND release_id = ? AND item_id = ? AND step_id IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY, releaseId, G.A]);
      const refused = await refusal(() => REL.startStep(db, c, stepRow.step_id, { view: 'none' }));
      const words = (refused?.problems ?? []).join(' | ');
      ok('the step is REFUSED, and the sentence names the requisition, the PO and its date', refused?.code === 'NOT_READY' && words.includes(pr.code) && /PO-\d+/.test(words) && /due \d+ \w+ 2026/.test(words), words || refused?.message);
      says(words);
      // A route rolls its transaction back on the refusal; here the one transaction goes on, so a savepoint does it.
      await db.query('SAVEPOINT floor_try');
      const floor = await refusal(() => REL.startStep(db, c, stepRow.step_id, { view: 'none', allowNotReady: true }));
      await db.query('ROLLBACK TO SAVEPOINT floor_try');
      ok('the machine log\'s start (readiness waived) still meets the ledger\'s hard stop, with the same detail', floor?.code === 'MATERIAL_NOT_RESERVED' && floor.message.includes(pr.code) && /due \d+ \w+ 2026/.test(floor.message), floor?.message);
      says(floor?.message);
      // Everything arrives: receive each PO line, reserve, start.
      const live = await prOf(GA.id);
      for (const l of [prLine(live, G.A), prLine(live, G.B)]) for (const p of l.purchase) if (p.outstanding > 0) await PS.receiveLine(db, c, p.purchaseLineId, { quantity: p.outstanding, stockingAreaId: G.store });
      const snapR = await snapshot();
      ok('all received (held for the requisition lines): every unit is ready', GA.units.every((k) => unitOf(snapR, k).material.state === 'ready'), j(GA.units.map((k) => unitOf(snapR, k).material.state)));
      const rv = await REL.reserveRelease(db, c, releaseId, { view: 'none' });
      ok('reserve all: nothing short — the holds moved onto the requirements', rv.short.length === 0 && Number((await db.query("SELECT COUNT(*) AS n FROM cf_stock_reservations WHERE company_id = ? AND held_for_order_id = ? AND status = 'active'", [COMPANY, GA.id]))[0][0].n) === 0, j(rv.short));
      const started = await refusal(() => REL.startStep(db, c, stepRow.step_id, { view: 'none' }));
      ok('after receipt + reserve the step STARTS', started === null, `${started?.message ?? ''} ${(started?.problems ?? []).join(' | ')}`);
      const snapS = await snapshot();
      ok('and the units stay ready (reserved / issued count as here)', GA.units.every((k) => unitOf(snapS, k).material.state === 'ready'));
    }

    if (run(16)) {
      section('16. Lifecycle');
      // (a) closing an order frees its holds and what was coming for it; a waiting order unblocks.
      { const it = await F.item('S16A'); await F.receive(it, 4);
        const Ao = await F.order('O16A', [[[it, 9]]]); const Bo = await F.order('O16B', [[[it, 9]]]);
        const prA = (await RQ.raiseRequisitions(db, c, Ao.id, {})).requisitions[0];
        const prB = (await RQ.raiseRequisitions(db, c, Bo.id, {})).requisitions[0];
        await RQ.stockCheck(db, c, prA.id, { apply: true });
        const made = await buy([[prLine(prA, it).id, 5, D(9)]]);
        await RQ.setSkip(db, c, prB.id, { all: true }, true);
        ok('(a) A holds 4 and has 5 coming; B (skipped) waits', (await lineState(Ao.line.id)).state === 'dated' && (await lineState(Bo.line.id)).state === 'waiting');
        await SO.setOrderStatus(db, c, Ao.id, 'closed');
        const [[al]] = await db.query('SELECT COUNT(*) AS n FROM cf_purchase_line_orders WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, Ao.id]);
        ok('(a) closing A: its holds are let go and its PO share is bought for nobody', Number((await activeHolds(it)).n) === 0 && Number(al.n) === 0);
        const b = await lineState(Bo.line.id);
        ok('(a) B has the 4 in stock and is still short of 5 (a skip never takes a PO, even a pooled one)', b.state === 'waiting' && reasonOf(b, it).short === 5 && reasonOf(b, it).cover.some((x) => x.kind === 'free' && x.qty === 4), j(reasonOf(b, it).cover));
        await RQ.setSkip(db, c, prB.id, { all: true }, false);
        const b2 = await lineState(Bo.line.id);
        ok(`(a) un-skipped, B is DATED by the freed PO line (pooled, ${D(9)}): the waiting order unblocked`, b2.state === 'dated' && b2.readyDate === D(9) && reasonOf(b2, it).cover.some((x) => x.pooled && x.poCode === made.purchaseOrders[0].code), j([b2.state, b2.readyDate])); }
      // (b) a PO cancelled → its requisition lines are open again.
      { const it = await F.item('S16B');
        const O = await F.order('O16C', [[[it, 3]]]);
        const pr = (await RQ.raiseRequisitions(db, c, O.id, {})).requisitions[0];
        const made = await buy([[prLine(pr, it).id, 3, D(5)]]);
        ok('(b) covered by a PO', (await prOf(O.id)).status === 'covered');
        await PS.cancelPurchaseOrder(db, c, made.purchaseOrders[0].id, { reason: 'supplier fell through' });
        const after = await prOf(O.id);
        ok('(b) PO cancelled: the line is OPEN again and the unit waits', prLine(after, it).status === 'open' && after.status === 'open' && after.materialReady.state === 'waiting' && prLine(after, it).purchase[0].state === 'closed', j([after.status, prLine(after, it).purchase]));
        // (c) a PO line's quantity reduced → part open again
        const made2 = await buy([[prLine(after, it).id, 3, D(5)]]);
        await PS.updatePurchaseLine(db, c, made2.purchaseOrders[0].lines[0].id, { quantity: 2 });
        const cut = await prOf(O.id);
        ok('(c) PO line cut from 3 to 2: 1 is open again', prLine(cut, it).status === 'part' && prLine(cut, it).cover.open === 1 && prLine(cut, it).cover.ordered === 2, j(prLine(cut, it).cover)); }
      // (d) a frozen order: cancel frees everything; unrelease puts reservations back on the requisition as holds.
      { const GB = await G.girderOrder('GB', 1);
        const t = totals(1);
        await G.receive(G.A, t.A); await G.receive(G.B, t.B); await G.receive(G.C, t.C);
        let pr = (await RQ.raiseRequisitions(db, c, GB.id, {})).requisitions[0];
        await RQ.stockCheck(db, c, pr.id, { apply: true });
        ok('(d) a frozen girder line held wholly from stock: fulfilled, unit ready', (await prOf(GB.id)).status === 'fulfilled_from_stock' && (await lineState(GB.lineId)).state === 'ready');
        const rel = await REL.releaseLine(db, c, GB.lineId, { finishedAreaId: G.dispatch, view: 'none' });
        const releaseId = rel.id ?? (await REL.liveReleaseOfLine(db, COMPANY, GB.lineId)).id;
        await REL.reserveRelease(db, c, releaseId, { view: 'none' });
        pr = await prOf(GB.id);
        ok('(d) release + reserve: the holds became reservations — still "from stock", still ready', prLine(pr, G.A).cover.reserved === t.A && prLine(pr, G.A).cover.held === 0 && pr.status === 'fulfilled_from_stock' && (await lineState(GB.lineId)).state === 'ready', j(prLine(pr, G.A).cover));
        await REL.unrelease(db, c, releaseId);
        pr = await prOf(GB.id);
        ok('(d) UNRELEASE: the reservations go back to the requisition lines as holds — the earmark is not lost', prLine(pr, G.A).cover.held === t.A && prLine(pr, G.B).cover.held === t.B && pr.status === 'fulfilled_from_stock' && (await availability(db, COMPANY, [G.A])).get(G.A).free === 0, j(pr.lines.map((l) => l.cover.held)));
        await SO.setOrderStatus(db, c, GB.id, 'cancelled');
        ok('(d) CANCEL: every hold is let go, the stock is free again', (await availability(db, COMPANY, [G.A])).get(G.A).free === t.A && (await availability(db, COMPANY, [G.C])).get(G.C).free >= t.C); }
      // (e) a revision: the requisition moves to the new line; a bigger need reopens it, a smaller one reports the excess.
      { const GC = await G.girderOrder('GC', 2);
        const t2 = totals(2);
        await G.receive(G.B, t2.B);
        let pr = (await RQ.raiseRequisitions(db, c, GC.id, {})).requisitions[0];
        await RQ.stockCheck(db, c, pr.id, { apply: true, lineIds: [prLine(pr, G.B).id] });
        await buy([[prLine(pr, G.A).id, t2.A, D(11)]], { supplier: G.SUP });
        await RQ.setSkip(db, c, pr.id, { lineIds: [prLine(pr, G.C).id] }, true);
        pr = await prOf(GC.id);
        ok('(e) before the revision: B from stock, A on order, C skipped', j([prLine(pr, G.B).status, prLine(pr, G.A).status, prLine(pr, G.C).status]) === j(['from_stock', 'covered', 'skipped']));
        const rev = await REV.reviseOrder(db, c, GC.id);
        const newLine = rev.lines[0].id;
        let moved = (await RQ.orderRequisitions(db, COMPANY, rev.id)).requisitions[0];
        ok('(e) REVISED: the requisition is on the new revision\'s line, with its holds, PO and skip', moved?.id === pr.id && moved.line.id === newLine && prLine(moved, G.B).cover.held === t2.B && prLine(moved, G.A).purchase.length === 1 && !!prLine(moved, G.C).skipped, j([moved?.id, moved?.line]));
        ok('(e) …its need is not known until the new line is frozen — it shows the need as raised', moved.needKnown === false && prLine(moved, G.A).need === t2.A && /not frozen/.test(moved.sentence), moved.sentence);
        await SO.updateOrderLine(db, c, newLine, { quantity: 3 });
        await LOCK.lockLine(db, c, newLine);
        moved = (await RQ.orderRequisitions(db, COMPANY, rev.id)).requisitions[0];
        const t3 = totals(3);
        ok('(e) re-frozen with 3 girders: the need went UP and the lines are open again', moved.stale === true && prLine(moved, G.A).need === t3.A && prLine(moved, G.A).status === 'part' && prLine(moved, G.A).cover.open === t3.A - t2.A
          && prLine(moved, G.B).status === 'part' && prLine(moved, G.B).needRaised === t2.B, j(moved.lines.map((l) => [l.status, l.need, l.needRaised, l.cover.open])));
        const refreshed = await RQ.raiseRequisitions(db, c, rev.id, {});
        ok('(e) refresh brings the stored need up to date (nothing else changes)', refreshed.refreshed === 1 && refreshed.requisitions[0].stale === false && prLine(refreshed.requisitions[0], G.A).needRaised === t3.A);
        // Now a SMALLER need: another revision, 1 girder.
        const rev2 = await REV.reviseOrder(db, c, rev.id);
        const line2 = rev2.lines[0].id;
        await SO.updateOrderLine(db, c, line2, { quantity: 1 });
        await LOCK.lockLine(db, c, line2);
        moved = (await RQ.orderRequisitions(db, COMPANY, rev2.id)).requisitions[0];
        const t1 = totals(1);
        ok('(e) re-frozen with 1 girder: the EXCESS is reported, nothing is dropped', prLine(moved, G.A).need === t1.A && prLine(moved, G.A).cover.over === t2.A - t1.A && prLine(moved, G.B).cover.over === t2.B - t1.B
          && prLine(moved, G.B).cover.held === t1.B && moved.counts.over === 2, j(moved.lines.map((l) => [l.need, l.cover.over, l.cover.held])));
        const [[heldB]] = await db.query("SELECT COALESCE(SUM(quantity), 0) AS q FROM cf_stock_reservations WHERE company_id = ? AND pr_line_id = ? AND status = 'active'", [COMPANY, prLine(moved, G.B).id]);
        ok('(e) …the holds are all still there', Number(heldB.q) === t2.B);
        const freeB = (await availability(db, COMPANY, [G.B])).get(G.B).free;
        const dryX = await RQ.releaseExcess(db, c, prLine(moved, G.B).id, {});
        ok('(e) release-excess, dry run: says what would be let go and writes nothing', dryX.applied === false && dryX.excess === t2.B - t1.B && dryX.plan.length === 1 && dryX.plan[0].kind === 'hold' && dryX.plan[0].quantity === t2.B - t1.B, j(dryX.plan));
        const didB = await RQ.releaseExcess(db, c, prLine(moved, G.B).id, { apply: true });
        const didA = await RQ.releaseExcess(db, c, prLine(moved, G.A).id, { apply: true });
        ok('(e) applied: B keeps exactly its need held; A\'s PO share is cut to its need (the PO line itself is not)', prLine(didB.requisition, G.B).cover.over === 0 && prLine(didB.requisition, G.B).cover.held === t1.B
          && didA.plan[0].kind === 'allocation' && prLine(didA.requisition, G.A).cover.over === 0 && prLine(didA.requisition, G.A).cover.ordered === t1.A, j([didA.plan, prLine(didA.requisition, G.A).cover]));
        ok('(e) the freed stock is free again', (await availability(db, COMPANY, [G.B])).get(G.B).free === freeB + t2.B - t1.B); }
      // (g) a revision DISCARDED: the requisition goes back to the line it came from, with its holds.
      { const GE = await G.girderOrder('GE', 1);
        await G.receive(G.B, PER_GIRDER.B);
        const pr = (await RQ.raiseRequisitions(db, c, GE.id, {})).requisitions[0];
        await RQ.stockCheck(db, c, pr.id, { apply: true, lineIds: [prLine(pr, G.B).id] });
        const rev = await REV.reviseOrder(db, c, GE.id);
        ok('(g) revised: the requisition sits on the revision\'s line', (await RQ.orderRequisitions(db, COMPANY, rev.id)).requisitions[0]?.line.id === rev.lines[0].id);
        const back = await REV.discardRevision(db, c, rev.id);
        const again = (await RQ.orderRequisitions(db, COMPANY, back.id)).requisitions[0];
        ok('(g) revision discarded: it is back on the original line, need known again, the hold still its own', back.id === GE.id && again?.id === pr.id && again.line.id === GE.lineId && again.needKnown === true
          && prLine(again, G.B).cover.held === PER_GIRDER.B && prLine(again, G.B).status === 'from_stock', j([again?.line, again?.needKnown, prLine(again, G.B).cover])); }
      // (f) deleting an order retires its requisition and lets its holds go.
      { const GD = await G.girderOrder('GD', 1, { status: 'inquiry' });
        await G.receive(G.A, PER_GIRDER.A);
        const freeBefore = (await availability(db, COMPANY, [G.A])).get(G.A).free;
        const pr = (await RQ.raiseRequisitions(db, c, GD.id, {})).requisitions[0];
        await RQ.stockCheck(db, c, pr.id, { apply: true, lineIds: [prLine(pr, G.A).id] });
        ok('(f) an inquiry\'s frozen line can be requisitioned and hold stock', (await availability(db, COMPANY, [G.A])).get(G.A).free === freeBefore - PER_GIRDER.A);
        await SO.deleteOrder(db, c, GD.id);
        const [[left]] = await db.query('SELECT COUNT(*) AS n FROM cf_requisitions WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [COMPANY, pr.id]);
        ok('(f) order deleted: its requisition is retired and the stock is free again', Number(left.n) === 0 && (await availability(db, COMPANY, [G.A])).get(G.A).free === freeBefore); }
    }
  }
} catch (err) {
  H.state.failed += 1;
  console.error('\nERROR', err);
} finally {
  MR.setToday(null);
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

const after = await H.counts();
const drift = after.filter((a) => Number(a.n) !== Number(before.find((b) => b.name === a.name)?.n));
section('Rolled back');
ok('every cf_ table has the rows it had', drift.length === 0, drift.map((d) => d.name).join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.fails.length ? `\n  failed: ${H.state.fails.join('\n          ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
