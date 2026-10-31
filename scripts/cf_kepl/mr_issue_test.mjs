/**
 * mr_issue_test.mjs — "ISSUE NOW" ON A MATERIAL REQUEST and what follows from it (init.sql §95, 2026-10-31; found in the
 * demo dry run of 2026-10-30):
 *
 *   cd multi_app_be && node scripts/cf_kepl/mr_issue_test.mjs        CF_MR_ISSUE_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-MRI-<run>),
 * except an active machine of the company the maintenance order is raised on (as maintenance_test) and one item the
 * race section's second connection puts a temporary lot on (deleted again in `finally`).
 *
 *   1  a GENERAL MR: take from stock + a PO receipt → "Issue now": dry run writes nothing; ONE issue (used for General,
 *      from the store, naming the MR); the holds fall; the screen shows Issued, nothing more to issue, still covered;
 *      a second press is refused; part of a line; more than is earmarked refused; saving below what is issued refused;
 *      a reversal puts the stock back AND earmarks it to the MR again
 *   2  refusals: an order's own MR (issued from its production order), a stock MR
 *   3  a MAINTENANCE MR → the issue names the MO; the MO's parts cost (open: live; closed: stored, + other cost); the
 *      Maintenance summary counts it; postMovement refuses an unknown / closed MO and an MO on a receipt
 *   4  ORDER COSTING (§74): an issue from an MR raised BY HAND for the order = consumables (even of an item on the
 *      order's own MR); a plain issue of an item on the order's own MR = material; of an item on no MR = consumables
 *   5  THE BATCH-CODE RACE (uq_csb_code): two lots named the same code at once — a piece of another lot's code is
 *      named <code>-<piece>; a piece another transaction made a lot for meanwhile takes THAT lot; and for real, with a
 *      second connection holding the code until it commits
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const MRS = await imp('apps/cf_erp/services/materialReadyService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PRS = await imp('apps/cf_erp/services/purchaseRequestService.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const ST = await imp('apps/cf_erp/services/stockService.js');
const M = await imp('apps/cf_erp/services/maintenanceService.js');
const { orderCostSheets } = await imp('apps/cf_erp/services/valuationService.js');
const { nodeLots } = await imp('apps/cf_erp/services/productionLedgerService.js');
const { harness, simple, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_MR_ISSUE_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-MRI-${RUN}`;
const TODAY = '2026-10-18';
const EPS = 1e-6;
const H = harness(pool);
const { ok, section, refusal, j } = H;
const before = await H.counts();
const db = await pool.getConnection();
let other = null;        // the race section's second connection
let otherLot = null;     // …and the lot it committed (deleted in finally)

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const movementsOf = async (reqId) => (await db.query('SELECT * FROM cf_stock_movements WHERE company_id = ? AND requisition_id = ? ORDER BY id', [COMPANY, reqId]))[0];

try {
  await db.beginTransaction();
  attachNodeCache(db);
  MRS.setToday(TODAY);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  await quietCodes(db, COMPANY);
  const S = await simple(db, c, tag, { itemKeys: ['A', 'B', 'C', 'D', 'E', 'F'] });
  const { A, B, C, D, E, F } = S.items;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const VA = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-VA`, `${tag} Vendor A`]);
  const gl = (s, item) => s.lines.find((l) => Number(l.item.id) === Number(item));
  const prl = (p, item) => p.lines.find((l) => Number(l.item.id) === Number(item));

  /* ════════════════════ 1. a general MR → Issue now ════════════════════ */
  section('1. A GENERAL MR — take from stock, a PO receipt, then "Issue now"');
  await S.receive(A, 10);
  const G = await RQ.createRequisition(db, c, { forType: 'general', note: `${tag} workshop`, lines: [{ itemId: A, qty: 6 }, { itemId: B, qty: 4 }] });
  let gs = await PRS.mrScreen(db, COMPANY, G.id);
  ok('before anything is earmarked: nothing to issue, Issue now not offered', gs.canIssue === false && gs.issueReason === null && gs.lines.every((l) => l.toIssue === 0 && l.issued === 0), j([gs.canIssue, gs.issueReason, gs.lines.map((l) => [l.toIssue, l.issued])]));
  const none = await refusal(() => PRS.issueMr(db, c, G.id, {}));
  ok('…and pressing it says there is nothing earmarked yet', none?.code === 'NOTHING_TO_ISSUE', j([none?.code, none?.message]));
  gs = await PRS.saveMr(db, c, G.id, { lines: [{ lineId: gl(gs, A).id, takeFromStock: 6 }, { lineId: gl(gs, B).id, takeFromStock: 0 }] });
  // B is bought: PR → PO → approved → received (the GRN holds it for the MR line).
  let pr = await PRS.getPr(db, COMPANY, gs.purchaseRequest.id);
  pr = await PRS.addVendor(db, c, pr.id, { supplierId: VA });
  pr = await PRS.setQuotes(db, c, pr.vendors[0].id, { quotes: [{ lineId: prl(pr, B).id, rate: 50, deliveryDays: 2 }] });
  const po = (await PRS.raisePo(db, c, pr.vendors[0].id, { lines: [{ lineId: prl(pr, B).id, quantity: 4 }] })).purchaseOrder;
  await PS.approvePurchaseOrder(db, c, po.id, {});
  await PS.receiveLine(db, c, po.lines[0].id, { quantity: 4, stockingAreaId: S.store });
  gs = await PRS.mrScreen(db, COMPANY, G.id);
  ok('earmarked: A 6 (taken from stock), B 4 (received on its PO) — Issue now offered, used for General',
    gs.canIssue === true && near(gl(gs, A).toIssue, 6) && near(gl(gs, B).toIssue, 4) && gs.issueUsedFor === 'general', j([gs.canIssue, gs.issueUsedFor, gs.lines.map((l) => [l.item.code, l.toIssue])]));
  const statusBefore = gs.status;

  const [[{ nMov0 }]] = await db.query('SELECT COUNT(*) AS nMov0 FROM cf_stock_movements WHERE company_id = ?', [COMPANY]);
  const dry = await PRS.issueMr(db, c, G.id, { dryRun: true });
  const [[{ nMov1 }]] = await db.query('SELECT COUNT(*) AS nMov1 FROM cf_stock_movements WHERE company_id = ?', [COMPANY]);
  const [[{ heldNow }]] = await db.query("SELECT COALESCE(SUM(quantity), 0) AS heldNow FROM cf_stock_reservations WHERE pr_line_id IN (?) AND status = 'active'", [gs.lines.map((l) => l.id)]);
  ok('dry run: the plan (A 6, B 4 from the store), nothing written', dry.dryRun === true && Number(nMov1) === Number(nMov0) && near(heldNow, 10)
    && dry.lines.length === 2 && dry.lines.every((l) => l.from.length === 1 && l.from[0].area === `${tag}-ST`), j([dry, nMov0, nMov1, heldNow]));

  const part = await PRS.issueMr(db, c, G.id, { lines: [{ lineId: gl(gs, A).id, quantity: 2 }] });
  let movs = await movementsOf(G.id);
  ok('part of a line: ONE issue of A 2, used for General, naming the MR, from the store',
    movs.length === 1 && movs[0].movement_type === 'issue' && movs[0].used_for === 'general' && movs[0].order_id == null && movs[0].reference === G.code
      && part.movement.lines?.length === 1 && near(Math.abs(part.movement.lines[0].quantity ?? part.movement.lines[0].legs?.[0]?.quantity ?? 2), 2), j([movs, part.movement.lines]));
  gs = part.materialRequest;
  ok('the screen: A issued 2, 4 still to issue; B 4 to issue', near(gl(gs, A).issued, 2) && near(gl(gs, A).toIssue, 4) && near(gl(gs, B).toIssue, 4), j(gs.lines.map((l) => [l.item.code, l.issued, l.toIssue])));
  const over = await refusal(() => PRS.issueMr(db, c, G.id, { lines: [{ lineId: gl(gs, A).id, quantity: 5 }] }));
  ok('more than is earmarked is refused, saying how much is', !!over && /4 kg is earmarked/.test(j(over.problems ?? over.message)), j(over?.problems ?? over?.message));
  const all = await PRS.issueMr(db, c, G.id, {});
  movs = await movementsOf(G.id);
  gs = all.materialRequest;
  const [ledger] = await db.query('SELECT item_id, SUM(quantity) q FROM cf_stock_ledger WHERE movement_id = ? GROUP BY item_id', [all.movement.id]);
  ok('the rest in ONE more issue: A 4 and B 4', movs.length === 2 && ledger.length === 2 && ledger.every((r) => near(r.q, -4)), j(ledger));
  const [heldLeft] = await db.query("SELECT status, quantity FROM cf_stock_reservations WHERE pr_line_id IN (?) ORDER BY id", [gs.lines.map((l) => l.id)]);
  ok('the holds fell: none active, each consumed', heldLeft.length >= 2 && heldLeft.every((h) => h.status === 'consumed' && near(h.quantity, 0)), j(heldLeft));
  ok('the screen: A issued 6, B issued 4, nothing more to issue — Issue now no longer offered', near(gl(gs, A).issued, 6) && near(gl(gs, B).issued, 4) && gs.lines.every((l) => l.toIssue === 0) && gs.canIssue === false, j(gs.lines.map((l) => [l.issued, l.toIssue])));
  ok(`still covered: the same status (${statusBefore}), locked = issued`, gs.status === statusBefore && near(gl(gs, A).locked, 6) && near(gl(gs, B).locked, 4), j([gs.status, gs.lines.map((l) => [l.status, l.locked])]));
  const again = await refusal(() => PRS.issueMr(db, c, G.id, {}));
  ok('a second press: nothing left to issue', again?.code === 'NOTHING_TO_ISSUE', j(again?.code));
  const [bal] = await db.query('SELECT item_id, SUM(quantity) q FROM cf_stock_balances WHERE company_id = ? AND stocking_area_id = ? AND item_id IN (?) GROUP BY item_id', [COMPANY, S.store, [A, B]]);
  const balOf = (it) => Number(bal.find((r) => Number(r.item_id) === it)?.q ?? 0);
  ok('stock: A 4 left in the store (10 − 6), B 0', near(balOf(A), 4) && near(balOf(B), 0), j(bal));
  const same = await PRS.saveMr(db, c, G.id, { lines: [{ lineId: gl(gs, A).id, takeFromStock: 6 }, { lineId: gl(gs, B).id, takeFromStock: 0 }] });
  ok('saving the MR again unchanged is fine (nothing held, nothing let go)', same.saved.held === 0 && same.saved.released === 0, j(same.saved));
  const lower = await refusal(() => PRS.saveMr(db, c, G.id, { lines: [{ lineId: gl(gs, A).id, takeFromStock: 2 }] }));
  ok('taking less from stock than is already issued is refused, saying it is issued', !!lower && /already issued/.test(j(lower.problems ?? lower.message)), j(lower?.problems ?? lower?.message));
  const rev = await ST.reverseMovement(db, c, all.movement.id, { reason: `${tag} wrong bin` });
  ok('the reversal keeps the MR on it', Number((await db.query('SELECT requisition_id FROM cf_stock_movements WHERE id = ?', [rev.id]))[0][0].requisition_id) === G.id);
  gs = await PRS.mrScreen(db, COMPANY, G.id);
  ok('reversed: A issued 2, B 0 — and the 4 + 4 are earmarked to the MR again (to issue)', near(gl(gs, A).issued, 2) && near(gl(gs, B).issued, 0) && near(gl(gs, A).toIssue, 4) && near(gl(gs, B).toIssue, 4) && gs.canIssue === true,
    j(gs.lines.map((l) => [l.item.code, l.issued, l.toIssue])));
  ok('…still covered', gs.status === statusBefore, gs.status);
  const back = await PRS.issueMr(db, c, G.id, {});
  ok('and Issue now takes it again', near(gl(back.materialRequest, A).issued, 6) && near(gl(back.materialRequest, B).issued, 4));

  /* ════════════════════ 2. refusals ════════════════════ */
  section("2. Not issued here: an order's own MR, an MR for stock");
  await S.receive(C, 5);
  const SO = await S.order('SO1', [[[C, 2]]]);
  const raised = await RQ.raiseRequisitions(db, c, SO.id, {});
  const own = raised.requisitions[0];
  let os = await PRS.mrScreen(db, COMPANY, own.id);
  os = await PRS.saveMr(db, c, own.id, { lines: os.lines.map((l) => ({ lineId: l.id, takeFromStock: l.proposedTake ?? 0 })) });
  ok("an order's own MR: Issue now not offered, the reason names the production order", os.canIssue === false && /production order/.test(os.issueReason ?? ''), j([os.canIssue, os.issueReason]));
  const ownRef = await refusal(() => PRS.issueMr(db, c, own.id, {}));
  ok('…and refused if pressed anyway', ownRef?.code === 'NOT_ISSUED_HERE', j(ownRef?.code));
  const stockMr = await RQ.createRequisition(db, c, { forType: 'stock', lines: [{ itemId: E, qty: 3 }] });
  const stockRef = await refusal(() => PRS.issueMr(db, c, stockMr.id, {}));
  ok('an MR for stock: refused (it refills stock)', stockRef?.code === 'NOT_ISSUED_HERE' && /refills stock/.test(stockRef.message), j(stockRef?.message));

  /* ════════════════════ 3. a maintenance MR → the MO's parts cost ════════════════════ */
  section("3. A MAINTENANCE MR — the issue names the MO; the MO's parts cost and the summary");
  const [[machine]] = await db.query("SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1", [COMPANY]);
  if (!machine) {
    console.log('  (no active machine in this company — section 3 skipped)');
  } else {
    await S.receive(F, 5);
    const mo = (await M.createOrder(db, c, { machineId: machine.id, title: `${tag} replace bearing` })).order;
    const moMr = (await M.raiseRequisition(db, c, mo.id, { lines: [{ itemId: F, qty: 2 }] })).requisition;
    let ms = await PRS.mrScreen(db, COMPANY, moMr.id);
    ms = await PRS.saveMr(db, c, moMr.id, { lines: [{ lineId: gl(ms, F).id, takeFromStock: 2 }] });
    ok('the MO\'s MR: Issue now offered, used for General', ms.canIssue === true && ms.issueUsedFor === 'general', j([ms.canIssue, ms.issueUsedFor]));
    let open = await M.getOrder(db, COMPANY, mo.id);
    ok('before the issue: no parts cost on the MO', open.partsCost === null && open.cost === null, j([open.partsCost, open.cost]));
    const done = await PRS.issueMr(db, c, moMr.id, {});
    const [[mv]] = await db.query('SELECT used_for, order_id, maintenance_order_id, requisition_id FROM cf_stock_movements WHERE id = ?', [done.movement.id]);
    ok('the issue names the MO and the MR, used for General', Number(mv.maintenance_order_id) === mo.id && Number(mv.requisition_id) === moMr.id && mv.used_for === 'general' && mv.order_id == null, j(mv));
    ok('…and the movement says so', done.movement.maintenanceOrderId === mo.id && done.movement.requisitionId === moMr.id, j([done.movement.maintenanceOrderId, done.movement.requisitionId]));
    open = await M.getOrder(db, COMPANY, mo.id);
    ok('the open MO: parts cost ₹20 (2 × ₹10) and cost ₹20, without typing', open.partsCost === 20 && open.cost === 20, j([open.partsCost, open.cost]));
    const listed = (await M.listOrders(db, COMPANY, { status: 'active', search: tag })).rows.find((r) => r.id === mo.id);
    ok('the MO list says the same', listed?.partsCost === 20 && listed?.cost === 20, j([listed?.partsCost, listed?.cost]));
    const sumBefore = await M.maintenanceSummary(db, COMPANY);
    await M.closeOrder(db, c, mo.id, { otherCost: 100, costNote: `${tag} outside rewinding` });
    const closed = await M.getOrder(db, COMPANY, mo.id);
    ok('closed with other cost ₹100: parts ₹20 stored, cost ₹120', closed.partsCost === 20 && closed.otherCost === 100 && closed.cost === 120, j([closed.partsCost, closed.otherCost, closed.cost]));
    const sumAfter = await M.maintenanceSummary(db, COMPANY);
    ok('the Maintenance summary counts it: cost up by ₹120, one more done this week', near(sumAfter.cost - sumBefore.cost, 120) && sumAfter.doneThisWeek === sumBefore.doneThisWeek + 1, j([sumBefore.cost, sumAfter.cost]));
    const issueLine = { movementType: 'issue', usedFor: 'general', fromAreaId: S.store, lines: [{ itemId: F, quantity: 1 }] };
    const closedRef = await refusal(() => ST.postMovement(db, c, { ...issueLine, maintenanceOrderId: mo.id }));
    ok('postMovement: a closed MO is refused', !!closedRef && /is done/.test(j(closedRef.problems ?? closedRef.message)), j(closedRef?.problems ?? closedRef?.message));
    const unknown = await refusal(() => ST.postMovement(db, c, { ...issueLine, maintenanceOrderId: 987654321 }));
    ok('postMovement: an unknown MO is refused', !!unknown && /does not exist/.test(j(unknown.problems ?? unknown.message)), j(unknown?.problems));
    const onReceipt = await refusal(() => ST.postMovement(db, c, { movementType: 'receipt', toAreaId: S.store, maintenanceOrderId: mo.id, lines: [{ itemId: F, quantity: 1, unitCost: 1 }] }));
    ok('postMovement: only an issue names a maintenance order', !!onReceipt && /Only an issue/.test(j(onReceipt.problems ?? onReceipt.message)), j(onReceipt?.problems));
    const mo2 = (await M.createOrder(db, c, { machineId: machine.id, title: `${tag} grease` })).order;
    const byHand = await ST.postMovement(db, c, { ...issueLine, maintenanceOrderId: mo2.id });
    const o2 = await M.getOrder(db, COMPANY, mo2.id);
    ok('Movements › Issue naming an open MO by hand: costed to it too (₹10)', byHand.maintenanceOrderId === mo2.id && o2.partsCost === 10, j([byHand.maintenanceOrderId, o2.partsCost]));
  }

  /* ════════════════════ 4. order costing — material vs consumables ════════════════════ */
  section('4. ORDER COSTING — the order\'s own MR = material; a hand-raised MR for the order = consumables');
  await S.receive(A, 10);
  await S.receive(D, 10);
  await S.receive(E, 10);
  const SO2 = await S.order('SO2', [[[A, 3]]]);
  const own2 = (await RQ.raiseRequisitions(db, c, SO2.id, {})).requisitions[0];
  ok("the order's own MR lists A", (await PRS.mrScreen(db, COMPANY, own2.id)).lines.some((l) => Number(l.item.id) === A));
  const hand = await RQ.createRequisition(db, c, { forType: 'sales_order', orderId: SO2.id, note: `${tag} consumables for SO2`, lines: [{ itemId: A, qty: 1 }, { itemId: D, qty: 2 }] });
  let hs = await PRS.mrScreen(db, COMPANY, hand.id);
  hs = await PRS.saveMr(db, c, hand.id, { lines: [{ lineId: gl(hs, A).id, takeFromStock: 1 }, { lineId: gl(hs, D).id, takeFromStock: 2 }] });
  ok('the hand-raised MR for the order: Issue now used for the sales order', hs.canIssue === true && hs.issueUsedFor === 'order', j([hs.canIssue, hs.issueUsedFor]));
  const handIssue = await PRS.issueMr(db, c, hand.id, {});
  const [[hm]] = await db.query('SELECT used_for, order_id, requisition_id FROM cf_stock_movements WHERE id = ?', [handIssue.movement.id]);
  ok('…the issue is used for SO2 and names the MR', hm.used_for === 'order' && Number(hm.order_id) === SO2.id && Number(hm.requisition_id) === hand.id, j(hm));
  await ST.postMovement(db, c, { movementType: 'issue', usedFor: 'order', orderId: SO2.id, fromAreaId: S.store, lines: [{ itemId: A, quantity: 2 }] });
  await ST.postMovement(db, c, { movementType: 'issue', usedFor: 'order', orderId: SO2.id, fromAreaId: S.store, lines: [{ itemId: E, quantity: 4 }] });
  const sheet = (await orderCostSheets(db, COMPANY, [SO2.id])).get(SO2.id);
  const kindOf = (item, kind) => sheet.items.find((i) => i.itemId === item && i.kind === kind);
  ok('A issued from the hand-raised MR (1, ₹10) = consumable, though A is on the order\'s own MR', near(kindOf(A, 'consumable')?.quantity, 1) && near(kindOf(A, 'consumable')?.value, 10), j(sheet.items));
  ok('D from the hand-raised MR (2, ₹20) = consumable', near(kindOf(D, 'consumable')?.value, 20), j(sheet.items));
  ok('A issued with no MR (2, ₹20) = material — it is on the order\'s own MR', near(kindOf(A, 'material')?.quantity, 2) && near(kindOf(A, 'material')?.value, 20), j(sheet.items));
  ok('E issued with no MR, on no MR (4, ₹40) = consumable', near(kindOf(E, 'consumable')?.value, 40), j(sheet.items));
  ok('totals: material ₹20, consumables ₹70', near(sheet.material, 20) && near(sheet.consumables, 70), j([sheet.material, sheet.consumables]));

  /* ════════════════════ 5. the batch-code race ════════════════════ */
  section('5. THE BATCH-CODE RACE — two lots named one code at once (uq_csb_code)');
  const [[flow]] = await db.query('SELECT id FROM cf_operation_flows WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  if (!flow) {
    console.log('  (no operation flow in this company — section 5 skipped)');
  } else {
    const rel = SO2.line.releaseId;
    const piece = async (code) => {
      const pid = await ins('INSERT INTO cf_production_items (company_id, release_id, item_id, quantity, flow_id, depth, sort_order, code) VALUES (?, ?, ?, 1, ?, 0, 0, ?)', [COMPANY, rel, S.FG, flow.id, code]);
      return { id: pid, item_id: S.FG, code, item_code: `${tag}-FG` };
    };
    // Simulated in this transaction: the competitor's lot appears between nodeLots' "taken" read and its naming update
    // (what a second transaction committing in that gap looks like). The proxy adds it right before the update.
    const raceOn = (makeCompetitor) => {
      let fired = false;
      return new Proxy(db, {
        get: (t, p) => (p === 'query' ? async (sql, args) => {
          if (!fired && /^UPDATE cf_stock_batches SET code = CASE id/.test(String(sql))) { fired = true; await makeCompetitor(); }
          return t.query(sql, args);
        } : Reflect.get(t, p)),
      });
    };
    // For real (first — before this transaction holds any lock on the lots): a second connection holds the code (uncommitted) while this one names its lot; it commits after a moment.
    const p4 = await piece(`${tag}-P4`);
    other = await pool.getConnection();
    await other.query("SET SESSION innodb_lock_wait_timeout = 15");
    await other.beginTransaction();
    const [[anyItem]] = await other.query('SELECT master_id FROM cf_item_details WHERE company_id = ? AND deleted_at IS NULL ORDER BY master_id LIMIT 1', [COMPANY]);
    otherLot = (await other.query('INSERT INTO cf_stock_batches (company_id, item_id, code, received_on) VALUES (?, ?, ?, CURDATE())', [COMPANY, anyItem.master_id, `${tag}-P4`]))[0].insertId;
    const naming = nodeLots(db, c, [p4]);
    await new Promise((r) => { setTimeout(r, 700); });
    await other.commit();
    const lots4 = await naming;
    ok(`two transactions for real: the one that waited names its lot ${tag}-P4-<piece> instead of failing with 409`, lots4.get(p4.id)?.code === `${tag}-P4-${p4.id}`, j(lots4.get(p4.id)));
    const shared = `${tag}-GRP`;
    const p1 = await piece(shared);
    const lots1 = await nodeLots(raceOn(() => ins("INSERT INTO cf_stock_batches (company_id, item_id, code, received_on) VALUES (?, ?, ?, CURDATE())", [COMPANY, S.FG, shared])), c, [p1]);
    ok(`another lot took the code meanwhile: the piece's lot is named ${shared}-<piece>, no 409`, lots1.get(p1.id)?.code === `${shared}-${p1.id}`, j(lots1.get(p1.id)));
    const p2 = await piece(`${tag}-P2`);
    let theirs = null;
    const lots2 = await nodeLots(raceOn(async () => { theirs = await ins('INSERT INTO cf_stock_batches (company_id, item_id, code, received_on, production_item_id) VALUES (?, ?, ?, CURDATE(), ?)', [COMPANY, S.FG, `${tag}-P2`, p2.id]); }), c, [p2]);
    const [p2Lots] = await db.query('SELECT id FROM cf_stock_batches WHERE production_item_id = ? AND deleted_at IS NULL', [p2.id]);
    ok('the same piece got a lot from the other transaction meanwhile: it takes THAT lot, ours is dropped (one lot per piece)', lots2.get(p2.id)?.id === theirs && p2Lots.length === 1, j([lots2.get(p2.id)?.id, theirs, p2Lots]));
    const p3 = await piece(`${tag}-P3`);
    const lots3 = await nodeLots(db, c, [p3]);
    ok('no race: the lot is named by the piece, as before', lots3.get(p3.id)?.code === `${tag}-P3`, j(lots3.get(p3.id)));

  }
} finally {
  MRS.setToday(null);
  await db.rollback();
  detachNodeCache(db);
  db.release();
  if (other) {
    try { await other.rollback(); } catch { /* committed */ }
    if (otherLot) await other.query('DELETE FROM cf_stock_batches WHERE id = ?', [otherLot]);
    other.release();
  }
}

const after = await H.counts();
const changed = after.filter((a) => (before.find((b) => b.name === a.name)?.n ?? 0) !== a.n).map((a) => a.name);
ok('ROLLED BACK: every cf_ table has exactly the rows it had', changed.length === 0, changed.join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed`);
if (H.state.failed) { console.log(H.state.fails.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1; }
await pool.end();
