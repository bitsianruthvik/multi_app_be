/**
 * stores_chain_test.mjs — THE STORES CHAIN (init.sql §79, TM/s79.sql; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Stores chain (S1 S2 S3 S7)"): Need → MR → STORES (take from stock, raise the PR) → Purchase → GRN → stock.
 *
 *   cd multi_app_be && node scripts/cf_kepl/stores_chain_test.mjs        CF_STORES_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-STO-<run>).
 * Line 923 is never touched.
 *
 *   1  a GENERAL MR with no order: refusals, MR-000123, Stores' inbox, take from stock (held for nobody else), the rest → PR
 *      → PO (no order on its shares) → GRN held for the MR line; a maintenance / general MR may name a sales order
 *   2  a SALES ORDER's MR → Stores take from stock → PR; the order's own MR stage never sees the hand-raised MR; the
 *      engine never counts the general MR's holds for the order
 *   3  procurement method: defaults (template = make, bought item = on requirement, made item = make), a definition's
 *      method inherited by its temporary item, an override, clear → inherit again, refusals
 *   4  the reorder engine (by AI): min / max (min order qty + multiple), periodic (used since the period began), on
 *      requirement never, a periodic item not due yet never
 *   5  ticked rows → "Raise PR": ONE PR for stock (an internal MR underneath, §93 — not in the MR inbox, reachable from
 *      its PR); the list empties; a stock MR takes nothing from stock; its GRN is FREE stock (no hold) and the engine pools it
 *   6  a machine's own store (found or made once); round trips of createRequisition
 *   7  Stores' own "New PR" (§93, user 2026-10-27): straight to a PR (general charged to a sales order, stock, a
 *      maintenance order), the MR underneath internal and out of the inbox; the same refusals as New MR; a department's
 *      New MR is a real request (in the inbox); a request body cannot make an MR internal
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
const PM = await imp('apps/cf_erp/services/procurementMethodService.js');
const SA = await imp('apps/cf_erp/services/stockingAreaService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const { availability } = await imp('apps/cf_erp/services/rollOutService.js');
const { harness, simple, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_STORES_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-STO-${RUN}`;
const TODAY = '2026-10-18';
const EPS = 1e-6;
const H = harness(pool);
const { ok, section, refusal, j, measured } = H;
const before = await H.counts();
const db = await pool.getConnection();

const freeOf = async (itemId) => (await availability(db, COMPANY, [itemId])).get(itemId)?.free ?? 0;

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
  await S.receive(A, 5);

  /* ════════════════════ 1. a general MR with no order ════════════════════ */
  section('1. A GENERAL MR with no order — Stores take from stock, the rest goes on the PR');
  const bad = await refusal(() => RQ.createRequisition(db, c, { forType: 'nonsense', lines: [] }));
  ok('refused: an unknown "For" and no lines, said at once', bad?.code === 'VALIDATION_FAILED' || (bad?.problems?.length ?? 0) >= 2, j([bad?.code, bad?.problems]));
  const so0 = await refusal(() => RQ.createRequisition(db, c, { forType: 'sales_order', lines: [{ itemId: A, qty: 1 }] }));
  ok('refused: an MR for a sales order names the order', !!so0 && /names the order/.test(j(so0.problems ?? so0.message)), j(so0?.problems));
  const st0 = await refusal(() => RQ.createRequisition(db, c, { forType: 'stock', orderId: 1, lines: [{ itemId: A, qty: 0 }] }));
  ok('refused: a stock MR with an order, and a zero quantity', !!st0 && (st0.problems ?? []).length >= 2, j(st0?.problems));
  const mt0 = await refusal(() => RQ.createRequisition(db, c, { forType: 'maintenance_order', lines: [{ itemId: A, qty: 1 }] }));
  ok('refused: an MR for a maintenance order names it', !!mt0 && /maintenance order/.test(j(mt0.problems ?? mt0.message)), j(mt0?.problems));

  const created = await measured(db, (m) => RQ.createRequisition(m, c, { forType: 'general', note: `${tag} workshop consumables`, lines: [{ itemId: A, qty: 3 }, { itemId: B, qty: 4 }, { itemId: A, qty: 1 }] }));
  const G = created.result;
  ok('createRequisition → { id, code }, numbered MR-000123', Number.isInteger(G.id) && /^MR-\d{6,}$/.test(G.code), j(G));
  ok(`createRequisition is set-based: ${created.queries} round trips (≤ 5)`, created.queries <= 5, String(created.queries));
  const [[gRow]] = await db.query('SELECT for_type, order_id, order_line_id, supply, notes FROM cf_requisitions WHERE id = ?', [G.id]);
  ok('stored: For general, no order, no line, we buy', gRow.for_type === 'general' && gRow.order_id == null && gRow.order_line_id == null && gRow.supply === 'we_buy', j(gRow));
  const inbox = await PRS.listMrs(db, COMPANY, { for: 'general', search: tag });
  const gInbox = inbox.rows.find((r) => r.id === G.id);
  ok("Stores' inbox, filtered by For = general, lists it — no order, no line", !!gInbox && gInbox.forType === 'general' && gInbox.order === null && gInbox.line === null && gInbox.manual === true, j(gInbox));
  ok('the inbox filtered by For = stock does not', !(await PRS.listMrs(db, COMPANY, { for: 'stock', search: tag })).rows.some((r) => r.id === G.id));
  let gs = await PRS.mrScreen(db, COMPANY, G.id);
  const gl = (s, item) => s.lines.find((l) => Number(l.item.id) === Number(item));
  ok('the same item twice is added up: A 4, B 4', gl(gs, A).required === 4 && gl(gs, B).required === 4 && gs.lines.length === 2, j(gs.lines.map((l) => [l.item.code, l.required])));
  ok('the screen proposes take from stock A 4 (5 free), B 0', gl(gs, A).proposedTake === 4 && gl(gs, B).proposedTake === 0 && gs.canEdit === true, j(gs.lines.map((l) => l.proposedTake)));
  gs = await PRS.saveMr(db, c, G.id, { lines: [{ lineId: gl(gs, A).id, takeFromStock: 4 }, { lineId: gl(gs, B).id, takeFromStock: 0 }] });
  const [gHolds] = await db.query("SELECT held_for_order_id, quantity FROM cf_stock_reservations WHERE pr_line_id = ? AND status = 'active'", [gl(gs, A).id]);
  ok('saved: A 4 held for the MR line, held for NO order', gHolds.length === 1 && gHolds[0].held_for_order_id == null && Number(gHolds[0].quantity) === 4, j(gHolds));
  ok('A: 1 free left for anybody else', Math.abs(await freeOf(A) - 1) < EPS);
  ok('A shows as locked (4 of 4); B 0', gl(gs, A).locked === 4 && gl(gs, B).locked === 0, j(gs.lines.map((l) => l.locked)));
  ok('ONE PR made for the rest', !!gs.purchaseRequest, j(gs.purchaseRequest));
  let pr = await PRS.getPr(db, COMPANY, gs.purchaseRequest.id);
  const prl = (p, item) => p.lines.find((l) => Number(l.item.id) === Number(item));
  ok('the PR: nothing of A to buy, B 4; no order, no line, For general', (prl(pr, A)?.needed ?? 0) === 0 && prl(pr, B)?.needed === 4 && pr.order === null && pr.line === null && pr.manual === true && pr.requisition.forType === 'general', j([pr.lines.map((l) => [l.item.code, l.needed]), pr.order, pr.requisition]));
  ok("Purchase's PR list shows it", (await PRS.listPrs(db, COMPANY, { search: gs.code })).rows.some((r) => r.id === pr.id));
  pr = await PRS.addVendor(db, c, pr.id, { supplierId: VA });
  pr = await PRS.setQuotes(db, c, pr.vendors[0].id, { quotes: [{ lineId: prl(pr, B).id, rate: 120, deliveryDays: 3 }] });
  const raised = await PRS.raisePo(db, c, pr.vendors[0].id, { lines: [{ lineId: prl(pr, B).id, quantity: 4 }] });
  const po = raised.purchaseOrder;
  const [shares] = await db.query('SELECT a.order_id, a.pr_line_id, a.quantity FROM cf_purchase_line_orders a JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id WHERE l.purchase_order_id = ? AND a.deleted_at IS NULL', [po.id]);
  ok('the PO (pending Management approval) names no order; its share is the MR line', shares.length === 1 && shares[0].order_id == null && Number(shares[0].pr_line_id) === gl(gs, B).id && po.forOrder == null, j([shares, po.forOrder]));
  await PS.approvePurchaseOrder(db, c, po.id, {});
  await PS.receiveLine(db, c, po.lines[0].id, { quantity: 4, stockingAreaId: S.store });
  const [bHolds] = await db.query("SELECT held_for_order_id, quantity FROM cf_stock_reservations WHERE pr_line_id = ? AND status = 'active'", [gl(gs, B).id]);
  ok('the GRN: B 4 held for the general MR line (for no order)', bHolds.length === 1 && bHolds[0].held_for_order_id == null && Number(bHolds[0].quantity) === 4, j(bHolds));
  ok('B: nothing free for anybody else', Math.abs(await freeOf(B)) < EPS);
  gs = await PRS.mrScreen(db, COMPANY, G.id);
  ok('the general MR is covered: all locked', gs.status === 'fulfilled_from_stock' || gs.status === 'covered', j([gs.status, gs.lines.map((l) => [l.status, l.locked])]));

  // Coordinator, 2026-10-18: a maintenance / general MR may ALSO name a sales order — its cost belongs to that order.
  const SO = await S.order('SO1', [[[A, 2], [C, 3]]]);
  const M1 = await RQ.createRequisition(db, c, { forType: 'maintenance_order', maintenanceOrderId: 987654, orderId: SO.id, lines: [{ itemId: C, qty: 1 }] });
  const G2 = await RQ.createRequisition(db, c, { forType: 'general', orderId: SO.id, lines: [{ itemId: C, qty: 1 }] });
  const [[m1Row]] = await db.query('SELECT for_type, order_id, maintenance_order_id, order_line_id FROM cf_requisitions WHERE id = ?', [M1.id]);
  ok('a maintenance MR naming a sales order keeps both (no line)', m1Row.for_type === 'maintenance_order' && Number(m1Row.order_id) === SO.id && Number(m1Row.maintenance_order_id) === 987654 && m1Row.order_line_id == null, j(m1Row));
  const byMo = await PRS.listMrs(db, COMPANY, { maintenanceOrderId: 987654 });
  ok('the inbox finds MRs of a maintenance order', byMo.rows.length === 1 && byMo.rows[0].id === M1.id && byMo.rows[0].order?.id === SO.id, j(byMo.rows.map((r) => r.code)));
  ok('a general MR may name a sales order too', (await PRS.mrScreen(db, COMPANY, G2.id)).order?.id === SO.id);

  /* ════════════════════ 2. a sales order's MR → Stores ════════════════════ */
  section("2. A SALES ORDER's MR → Stores take from stock → PR");
  await S.receive(C, 1);
  const raisedSo = await RQ.raiseRequisitions(db, c, SO.id, {});
  const soMr = raisedSo.requisitions[0];
  ok("the order's MR stage lists ONLY its own MR (not the two raised by hand for it)", raisedSo.requisitions.length === 1 && soMr.line?.id === SO.line.id && soMr.forType === 'sales_order', j(raisedSo.requisitions.map((r) => r.code)));
  const soInbox = await PRS.listMrs(db, COMPANY, { for: 'sales_order', search: tag });
  ok("Stores' inbox, For = sales order, lists the order's MR", soInbox.rows.some((r) => r.id === soMr.id && r.line?.lineNo === 1));
  let ss = await PRS.mrScreen(db, COMPANY, soMr.id);
  ok('Stores see it: A needs 2 (1 free), C needs 3 (1 free — the hand-raised MRs hold nothing yet)', gl(ss, A).required === 2 && gl(ss, A).proposedTake === 1 && gl(ss, C).required === 3 && gl(ss, C).proposedTake === 1, j(ss.lines.map((l) => [l.item.code, l.required, l.proposedTake])));
  ss = await PRS.saveMr(db, c, soMr.id, { lines: ss.lines.map((l) => ({ lineId: l.id, takeFromStock: l.proposedTake })) });
  const [soHolds] = await db.query("SELECT held_for_order_id FROM cf_stock_reservations WHERE pr_line_id IN (?) AND status = 'active'", [ss.lines.map((l) => l.id)]);
  ok("the order's MR holds for the ORDER (as before)", soHolds.length === 2 && soHolds.every((h) => Number(h.held_for_order_id) === SO.id), j(soHolds));
  const soPr = await PRS.getPr(db, COMPANY, ss.purchaseRequest.id);
  ok('its PR: A 1, C 2 to buy; it names the order and line', prl(soPr, A)?.needed === 1 && prl(soPr, C)?.needed === 2 && soPr.order?.id === SO.id && soPr.line?.id === SO.line.id && soPr.manual === false, j(soPr.lines.map((l) => [l.item.code, l.needed])));
  const order = await RQ.orderRequisitions(db, COMPANY, SO.id);
  const aLine = order.requisitions[0].lines.find((l) => Number(l.item.id) === A);
  ok("the order's A cover: 1 from stock, 1 still open (the general MR's holds are not the order's)", Math.abs(aLine.cover.stock - 1) < EPS && Math.abs(aLine.cover.open - 1) < EPS, j(aLine.cover));

  /* ════════════════════ 3. procurement method ════════════════════ */
  section('3. How each item is procured — defaults, a definition inherited by its temporary item, an override');
  const pA = await PM.readProcurement(db, COMPANY, A);
  ok('a bought catalog item defaults to "buy on requirement"', pA.source === 'default' && pA.effective.method === 'buy_on_requirement', j([pA.source, pA.effective.method]));
  const [[{ variant }]] = await db.query('SELECT classification_id AS variant FROM cf_master_records WHERE id = ?', [A]);
  const made = await MR.createItem(db, c, { itemType: 'catalog', classificationId: variant, code: `${tag}-MADE`, name: `${tag} made in house`, uom: 'nos', status: 'active', sourcing: 'make' });
  ok('an item made in-house defaults to "make"', (await PM.readProcurement(db, COMPANY, made.id)).effective.method === 'make');
  const def = await MR.createDefinition(db, c, { definitionType: 'template', classificationId: variant, code: `${tag}-DEF`, name: `${tag} cleat`, shortName: 'CL', status: 'active' });
  let pDef = await PM.readProcurement(db, COMPANY, def.id);
  ok('a template definition (cut pieces, assemblies) defaults to "make"', pDef.source === 'default' && pDef.effective.method === 'make' && pDef.subject.kind === 'definition', j([pDef.source, pDef.effective.method]));
  // A temporary item of an order line, made from the definition (as a template line would).
  const tmp = await MR.createItem(db, c, { itemType: 'temporary', sourceDefinitionId: def.id, ownerOrderLineId: SO.line.id, code: `${tag}-TMP`, name: `${tag} cleat on SO1`, uom: 'nos' }, { place: async () => {} });
  let pTmp = await PM.readProcurement(db, COMPANY, tmp.id);
  ok('the temporary item inherits its definition\'s default (make)', pTmp.source === 'definition' && pTmp.effective.method === 'make' && pTmp.inherited?.from?.id === def.id, j([pTmp.source, pTmp.effective.method, pTmp.inherited]));
  pDef = await PM.setProcurement(db, c, def.id, { method: 'subcontract', leadTimeDays: 12, preferredVendorIds: [VA] });
  pTmp = await PM.readProcurement(db, COMPANY, tmp.id);
  ok('set on the DEFINITION (subcontract, 12 days, Vendor A) → the temporary item inherits it all', pTmp.source === 'definition' && pTmp.effective.method === 'subcontract' && pTmp.effective.leadTimeDays === 12 && pTmp.effective.preferredVendors[0]?.id === VA, j(pTmp.effective));
  pTmp = await PM.setProcurement(db, c, tmp.id, { method: 'customer_supplies' });
  ok('the temporary item OVERRIDES it (customer supplies)', pTmp.source === 'own' && pTmp.effective.method === 'customer_supplies' && pTmp.inherited.settings.method === 'subcontract', j([pTmp.source, pTmp.effective.method]));
  pTmp = await PM.setProcurement(db, c, tmp.id, { method: null });
  ok('cleared → it inherits again', pTmp.source === 'definition' && pTmp.effective.method === 'subcontract');
  const eff = await PM.effectiveMethods(db, COMPANY, [A, tmp.id, def.id, made.id]);
  ok('effectiveMethods (one read): A on requirement, temporary subcontract (definition), definition subcontract (own), made make',
    eff.get(A).method === 'buy_on_requirement' && eff.get(tmp.id).method === 'subcontract' && eff.get(tmp.id).source === 'definition' && eff.get(def.id).source === 'own' && eff.get(made.id).method === 'make', j([...eff]));
  const badP = await refusal(() => PM.setProcurement(db, c, D, { method: 'buy_min_max', minQty: 10, maxQty: 5, orderMultiple: 0 }));
  ok('refused at once: max not above min, an order multiple of 0', (badP?.problems ?? []).length >= 2, j(badP?.problems));
  const badP2 = await refusal(() => PM.setProcurement(db, c, E, { method: 'buy_periodic' }));
  ok('refused: periodic needs "every N days"', !!badP2 && /Every N days/.test(j(badP2.problems)), j(badP2?.problems));

  /* ════════════════════ 4. the reorder engine ════════════════════ */
  section('4. The reorder engine (by AI) — min / max and periodic');
  await PM.setProcurement(db, c, A, { method: 'buy_on_requirement' });
  await PM.setProcurement(db, c, D, { method: 'buy_min_max', minQty: 10, maxQty: 50, minOrderQty: 20, orderMultiple: 5, leadTimeDays: 4, preferredVendorIds: [VA] });
  await PM.setProcurement(db, c, E, { method: 'buy_periodic', periodDays: 7 });
  await PM.setProcurement(db, c, F, { method: 'buy_periodic', periodDays: 7 });
  await db.query("UPDATE cf_procurement_settings SET periodic_from = '2026-10-08' WHERE company_id = ? AND master_id = ?", [COMPANY, E]);
  await S.receive(D, 3);
  await S.receive(E, 20);
  await S.receive(F, 20);
  await ST.postMovement(db, c, { movementType: 'issue', usedFor: 'general', movementDate: '2026-10-12', fromAreaId: S.store, lines: [{ itemId: E, quantity: 6 }] });
  await ST.postMovement(db, c, { movementType: 'issue', usedFor: 'general', movementDate: '2026-10-05', fromAreaId: S.store, lines: [{ itemId: E, quantity: 9 }] });
  await ST.postMovement(db, c, { movementType: 'issue', usedFor: 'general', movementDate: '2026-10-12', fromAreaId: S.store, lines: [{ itemId: F, quantity: 4 }] });
  const list = await measured(db, (m) => PM.reorderSuggestions(m, COMPANY, { search: tag }));
  const R = list.result;
  const row = (item) => R.rows.find((r) => r.item.id === item);
  console.log(R.rows.map((r) => `        ${r.item.code}: ${r.methodLabel} — suggest ${r.suggest} — ${r.why}`).join('\n'));
  ok(`the list is ${list.queries} round trips (≤ 6) whatever the number of items`, list.queries <= 6, String(list.queries));
  ok('D (min 10 / max 50, 3 free): suggest 50 − 3 = 47 → a multiple of 5 = 50', row(D)?.suggest === 50 && row(D).free === 3 && row(D).method === 'buy_min_max' && row(D).preferredVendors[0]?.id === VA && row(D).leadTimeDays === 4, j(row(D)));
  ok('E (every 7 days from 10-08, due 10-15): 6 used since then (not the 9 before) → suggest 6', row(E)?.suggest === 6 && row(E).used === 6 && row(E).dueOn === '2026-10-15', j(row(E)));
  ok('F (periodic, its period began today) is not due — not on the list', !row(F));
  ok('A (buy on requirement) and B, C (no method) never appear', !row(A) && !row(B) && !row(C));
  ok('the reasons are in words', /below the minimum 10/.test(row(D).why) && /Every 7 days/.test(row(E).why), j([row(D).why, row(E).why]));
  ok('roundOrder: 3 with min order 20 → 20; 21 by 5 → 25; 0 → 0', PM.roundOrder(3, { minOrderQty: 20 }) === 20 && PM.roundOrder(21, { orderMultiple: 5 }) === 25 && PM.roundOrder(0, { minOrderQty: 20 }) === 0);

  /* ════════════════════ 5. MR from the reorder list → PR ════════════════════ */
  section('5. Ticked rows → ONE MR for stock → its PR');
  const rr = await PM.raiseReorder(db, c, { rows: [{ itemId: D, qty: row(D).suggest }, { itemId: E, qty: row(E).suggest }] });
  ok('one MR for stock, saved at once → its PR', /^MR-\d{6,}$/.test(rr.requisition.code) && !!rr.purchaseRequest && rr.materialRequest.forType === 'stock', j([rr.requisition, rr.purchaseRequest]));
  // §93 (user 2026-10-27): "Raise PR" — the MR underneath is Stores' own bookkeeping, not a request waiting for Stores.
  const [[rrRow]] = await db.query('SELECT internal_pr FROM cf_requisitions WHERE id = ?', [rr.requisition.id]);
  ok('§93: the MR under "Raise PR" is internal (stored internal_pr = 1; the screen says internal)', Number(rrRow.internal_pr) === 1 && rr.materialRequest.internal === true, j([rrRow, rr.materialRequest.internal]));
  const inboxR = await PRS.listMrs(db, COMPANY, {});
  ok('§93: the MR inbox does NOT list it (All, and For = stock)', !inboxR.rows.some((r) => r.id === rr.requisition.id) && !(await PRS.listMrs(db, COMPANY, { for: 'stock' })).rows.some((r) => r.id === rr.requisition.id));
  ok('§93: …and its counts leave it out', inboxR.counts.all === inboxR.rows.length, j(inboxR.counts));
  const allR = await PRS.listMrs(db, COMPANY, { internal: 'all', search: rr.requisition.code });
  ok('§93: internal=all still finds it (internal: true)', allR.rows.some((r) => r.id === rr.requisition.id && r.internal === true), j(allR.rows.map((r) => [r.code, r.internal])));
  ok('§93: it stays reachable from its PR (the PR names it)', (await PRS.getPr(db, COMPANY, rr.purchaseRequest.id)).requisition?.id === rr.requisition.id);
  ok("§93: its screen says it is Stores' own purchase, naming the PR", rr.materialRequest.sentence.includes(rr.purchaseRequest.code) && /not in the MR inbox/.test(rr.materialRequest.sentence), rr.materialRequest.sentence);
  const sPr = await PRS.getPr(db, COMPANY, rr.purchaseRequest.id);
  ok('the PR buys everything: D 50, E 6 (nothing taken from stock)', prl(sPr, D)?.needed === 50 && prl(sPr, E)?.needed === 6 && sPr.requisition.forType === 'stock', j(sPr.lines.map((l) => [l.item.code, l.needed])));
  ok('the stock MR offers nothing to take from stock (take max 0), but shows what is free', rr.materialRequest.lines.every((l) => l.takeMax === 0) && rr.materialRequest.lines.find((l) => Number(l.item.id) === D).inStock === 3, j(rr.materialRequest.lines.map((l) => [l.takeMax, l.inStock])));
  const take = await refusal(() => PRS.saveMr(db, c, rr.requisition.id, { lines: [{ lineId: rr.materialRequest.lines[0].id, takeFromStock: 1 }] }));
  ok('refused: a stock MR takes nothing from stock', !!take && /refills stock/.test(j(take.problems)), j(take?.problems));
  const R2 = await PM.reorderSuggestions(db, COMPANY, { search: tag });
  ok('the list empties: D has 50 coming (3 + 50 ≥ 10); E\'s next period starts today', !R2.rows.some((r) => r.item.id === D || r.item.id === E), j(R2.rows.map((r) => r.item.code)));
  let sPr2 = await PRS.addVendor(db, c, sPr.id, { supplierId: VA });
  sPr2 = await PRS.setQuotes(db, c, sPr2.vendors[0].id, { quotes: [{ lineId: prl(sPr2, D).id, rate: 10, deliveryDays: 4 }] });
  const dPo = (await PRS.raisePo(db, c, sPr2.vendors[0].id, { lines: [{ lineId: prl(sPr2, D).id, quantity: 50 }] })).purchaseOrder;
  await PS.approvePurchaseOrder(db, c, dPo.id, {});
  const supply = await MRS.loadSupply(db, COMPANY, [D]);
  const pooledD = (supply.pooled.get(D) ?? []).reduce((t, p) => t + Number(p.b?.qty ?? p.b?.quantity ?? p.qty ?? 0), 0);
  ok("the engine pools a stock MR's PO: on order for anybody, not an order's", (supply.pooled.get(D) ?? []).length === 1, j([...(supply.pooled.get(D) ?? [])].map((p) => p.poCode)) + ` ${pooledD}`);
  await PS.receiveLine(db, c, dPo.lines[0].id, { quantity: 50, stockingAreaId: S.store });
  const [dHolds] = await db.query("SELECT COUNT(*) n FROM cf_stock_reservations WHERE item_id = ? AND status = 'active'", [D]);
  ok('the GRN of a stock MR holds nothing: D 53 free', Number(dHolds[0].n) === 0 && Math.abs(await freeOf(D) - 53) < EPS, j([dHolds, await freeOf(D)]));
  const sMr = await PRS.mrScreen(db, COMPANY, rr.requisition.id);
  const dLine = sMr.lines.find((l) => Number(l.item.id) === D);
  ok('the stock MR line D counts what arrived: covered, 50 received', dLine.received === 50 && ['from_stock', 'covered'].includes(dLine.status), j([dLine.status, dLine.received, dLine.locked]));
  const R3 = await PM.reorderSuggestions(db, COMPANY, { search: tag });
  ok('D stays off the list (53 free, nothing coming)', !R3.rows.some((r) => r.item.id === D));

  /* ════════════════════ 6. a machine's store ════════════════════ */
  section("6. A machine's own store");
  const [[mc]] = await db.query('SELECT id, code FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  if (mc) {
    const s1 = await SA.machineStore(db, c, mc.id);
    const s2 = await SA.machineStore(db, c, mc.id);
    ok('found or made ONCE: location kind machine, its machine, purpose wip', s1.id === s2.id && s1.locationKind === 'machine' && s1.machine?.id === mc.id && s1.purpose === 'wip', j(s1));
  } else ok('(no machine in this company — skipped)', true);
  const noMc = await refusal(() => SA.machineStore(db, c, 999999999));
  ok('an unknown machine is refused', noMc?.status === 404 || /not found/i.test(noMc?.message ?? ''), noMc?.message);

  /* ════════════════════ 7. Stores' own New PR ════════════════════ */
  section("7. Stores' own NEW PR — straight to a PR for Purchase; a department's New MR stays a request to Stores");
  const np = await PRS.raiseStoresPr(db, c, { forType: 'general', orderId: SO.id, note: `${tag} gas cylinders`, lines: [{ itemId: A, qty: 2 }, { itemId: B, qty: 3 }] });
  ok('New PR → { requisition, materialRequest, purchaseRequest }: a PR made at once', /^MR-\d{6,}$/.test(np.requisition.code) && /^PR-/.test(np.purchaseRequest?.code ?? ''), j([np.requisition, np.purchaseRequest]));
  const npPr = await PRS.getPr(db, COMPANY, np.purchaseRequest.id);
  ok('the PR buys everything typed (nothing taken from stock): A 2, B 3', prl(npPr, A)?.needed === 2 && prl(npPr, B)?.needed === 3, j(npPr.lines.map((l) => [l.item.code, l.needed])));
  ok('the PR is For general, charged to the sales order named', npPr.requisition.forType === 'general' && npPr.order?.id === SO.id, j([npPr.requisition, npPr.order]));
  const [npHolds] = await db.query("SELECT COUNT(*) n FROM cf_stock_reservations WHERE pr_line_id IN (?) AND status = 'active'", [np.materialRequest.lines.map((l) => l.id)]);
  ok('nothing was held from stock for it', Number(npHolds[0].n) === 0, j(npHolds));
  ok('the MR underneath is internal and NOT in the MR inbox', np.materialRequest.internal === true && !(await PRS.listMrs(db, COMPANY, { search: tag })).rows.some((r) => r.id === np.requisition.id));
  ok("Purchase's PR list shows the PR", (await PRS.listPrs(db, COMPANY, { search: np.requisition.code })).rows.some((r) => r.id === np.purchaseRequest.id));
  const npStock = await PRS.raiseStoresPr(db, c, { forType: 'stock', lines: [{ itemId: C, qty: 5 }] });
  ok('New PR for stock → a PR (C 5), internal', (await PRS.getPr(db, COMPANY, npStock.purchaseRequest.id)).lines.find((l) => Number(l.item.id) === C)?.needed === 5 && npStock.materialRequest.internal === true);
  const npMo = await PRS.raiseStoresPr(db, c, { forType: 'maintenance_order', maintenanceOrderId: 987655, lines: [{ itemId: C, qty: 1 }] });
  ok('New PR for a maintenance order → a PR, internal; the inbox by that maintenance order does not list it', !!npMo.purchaseRequest && !(await PRS.listMrs(db, COMPANY, { maintenanceOrderId: 987655 })).rows.length);
  const npBad = await refusal(() => PRS.raiseStoresPr(db, c, { forType: 'sales_order', lines: [{ itemId: A, qty: 0 }] }));
  ok('refused as New MR is, every problem at once: a sales order PR names the order, a zero quantity', (npBad?.problems ?? []).length >= 2 && /names the order/.test(j(npBad.problems)), j(npBad?.problems));
  const dept = await RQ.createRequisition(db, c, { forType: 'general', note: `${tag} paint for the yard`, internal: true, lines: [{ itemId: D, qty: 1 }] });
  const [[deptRow]] = await db.query('SELECT internal_pr FROM cf_requisitions WHERE id = ?', [dept.id]);
  ok("a department's New MR (POST /requisitions) is a real request: internal_pr 0 — a body's \"internal\" is ignored", Number(deptRow.internal_pr) === 0, j(deptRow));
  const deptInbox = (await PRS.listMrs(db, COMPANY, { search: tag })).rows.find((r) => r.id === dept.id);
  ok('…it is in the MR inbox (internal false), with no PR until Stores saves it', !!deptInbox && deptInbox.internal === false && deptInbox.purchaseRequest === null, j(deptInbox));
} finally {
  MRS.setToday(null);
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

const after = await H.counts();
const changed = after.filter((a) => (before.find((b) => b.name === a.name)?.n ?? 0) !== a.n).map((a) => a.name);
ok('ROLLED BACK: every cf_ table has exactly the rows it had', changed.length === 0, changed.join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed`);
if (H.state.failed) { console.log(H.state.fails.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1; }
await pool.end();
