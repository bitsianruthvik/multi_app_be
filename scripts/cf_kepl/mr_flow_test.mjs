/**
 * mr_flow_test.mjs — the MATERIAL REQUEST (MR) flow and CUSTOMER-SUPPLIED material, end to end
 * (init.sql §66, TM/s66.sql; contract TM/CF_ERP_BUYING_V2.md "2026-10-16 — Material request").
 *
 *   cd multi_app_be && node scripts/cf_kepl/mr_flow_test.mjs
 *   CF_MR_COMPANY (2) · CF_MR_TRANSCRIPT (TM/MR_FLOW_RUN.md — the state tables of every step, for a person)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own and named
 * TEST-MR-<run>: the orders, the items, the customers, the suppliers, the store. Line 923 is never touched.
 *
 *  A. WE BUY — an order of two lines (one girder each: A 4, B 6, C 5 kg), material supply "We buy", locked:
 *     1. the MR is raised with earmark: free stock is earmarked at once (A partly, C wholly); another customer's
 *        lot in the store is not touched
 *     2. two POs to match what is open; one PO serves BOTH MRs
 *     3. one PO is cancelled → its quantities are open again on the MR, by themselves
 *     4. a new PO covers it again
 *     5. a partial GRN on the PO that serves two MRs → earmarked to the MRs, oldest share first
 *     6. full GRN → every MR line earmarked
 *     7. release (the production order) → its reservations = the MR's earmarks, lot by lot ("Material from MR-…")
 *  B. NOT TRACKED IN NESTING — a nested line whose gussets are left over, then marked "cut from untracked offcuts":
 *     marked pieces put nothing on the MR and do not hold the line's material back
 *  C. CUSTOMER SUPPLIES — an order captured as "Customer supplies":
 *     1. raising the MR earmarks the customer's own lot already here, and AUTO-CREATES a PO to the customer as
 *        vendor (₹0) for the rest; our own stock is not touched
 *     2. who supplies it is fixed once the MR is raised (order and line)
 *     3. the customer PO cancelled → open again; brought up to date → a new customer PO
 *     4. partial + full GRN → the CUSTOMER's lots (owner = the customer, not costed as ours), earmarked to the MR
 *     5. another order's stock check and engine do not see the customer's material
 *     6. release → reservations = the MR's earmarks (their lots only); our stock untouched
 *     7. inventory by owner: ours / the customer, the customer's material not in our value
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const MRS = await imp('apps/cf_erp/services/materialReadyService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const OWN = await imp('apps/cf_erp/services/ownershipService.js');
const ST = await imp('apps/cf_erp/services/stockService.js');
const VAL = await imp('apps/cf_erp/services/valuationService.js');
const UT = await imp('apps/cf_erp/services/nestUntrackedService.js');
const NU = await imp('apps/cf_erp/services/nestDxfImportService.js');
const { availability } = await imp('apps/cf_erp/services/rollOutService.js');
const { harness, girder, quietCodes, addDays } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');
const NF = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');

const COMPANY = Number(process.env.CF_MR_COMPANY ?? 2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT = process.env.CF_MR_TRANSCRIPT ?? path.resolve(HERE, '../../../MR_FLOW_RUN.md');
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-MR-${RUN}`;
const TODAY = '2026-10-16';
const D = (n) => addDays(TODAY, n);
const EPS = 1e-6;

const H = harness(pool);
const { ok, section, refusal, j } = H;
const before = await H.counts();
const db = await pool.getConnection();

// ---- the transcript: what a person reads to believe it works ------------------------------------
const md = [];
const say = (s) => { md.push(`${s}
`); console.log(`        ${s}`); };
const step = (title, what) => { section(title); md.push(`\n## ${title}\n`); if (what) md.push(`${what}\n`); };
const table = (head, rows) => {
  const t = [`| ${head.join(' | ')} |`, `|${head.map((h, i) => (i === 0 ? '---' : '---:')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
  md.push(t.join('\n'), '');
  for (const l of t) console.log(`        ${l}`);
};
const n = (v) => String(Number(Number(v ?? 0).toFixed(3)));

try {
  await db.beginTransaction();
  attachNodeCache(db);
  MRS.setToday(TODAY);
  const [[user]] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  await quietCodes(db, COMPANY);
  const G = await girder(db, c, tag);
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const party = (key, name, role) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, status) VALUES (?, ?, ?, 1, 'active')`, [COMPANY, `${tag}-${key}`, `${tag} ${name}`]);
  const S1 = G.SUP;
  const S2 = await party('S2', 'Supplier two', 'is_supplier');
  const CUS_X = await party('CX', 'Customer X (sends its own steel)', 'is_customer');
  const CUS_Y = await party('CY', 'Customer Y', 'is_customer');
  const ITEM = { [G.A]: 'A', [G.B]: 'B', [G.C]: 'C' };
  const names = new Map([[S1, 'Supplier one'], [S2, 'Supplier two'], [CUS_X, 'Customer X'], [CUS_Y, 'Customer Y'], [G.CUS, 'Girder customer']]);

  /** An order of `lines` girders each, captured with its material supply, locked, confirmed. */
  const makeOrder = async (key, girders, { customer = G.CUS, materialSupply = 'we_buy' } = {}) => {
    const so = await SO.createOrder(db, c, { orderType: 'customer', customerId: customer, code: `${tag}-${key}`, committedDate: '2099-12-31', materialSupply });
    let o = so;
    for (const q of girders) o = await SO.addOrderLine(db, c, so.id, { recordId: G.GR.id, quantity: q });
    await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [G.prc.id, so.id]);
    for (const l of o.lines) await LOCK.lockLine(db, c, l.id);
    await SO.setOrderStatus(db, c, so.id, 'confirmed');
    return { id: so.id, code: `${tag}-${key}`, lines: o.lines.map((l) => ({ id: l.id, lineNo: l.lineNo })), supply: so.materialSupply };
  };
  const mrsOf = async (orderId) => (await RQ.orderRequisitions(db, COMPANY, orderId)).requisitions;
  const mrLine = (mr, itemId) => mr.lines.find((l) => Number(l.item.id) === Number(itemId));
  /** THE STATE TABLE of an order's MRs: need / earmarked / on PO / received / open, per MR line. */
  const stateOf = async (orderId, label = null) => {
    const mrs = await mrsOf(orderId);
    if (label) md.push(`**${label}**\n`);
    table(['MR', 'Material', 'Need', 'Earmarked', 'On PO', 'Received', 'Open', 'Status'],
      mrs.flatMap((r) => r.lines.map((l) => [r.code, l.item.code.replace(`${tag}-`, ''), n(l.need), n(l.cover.earmarked), n(l.cover.onPo), n(l.cover.received), n(l.cover.open), l.statusLabel])));
    return mrs;
  };
  /** Stock of this run's items by OWNER: on hand, earmarked to an MR (holds), reserved for production, free. */
  const stockByOwner = async (label = 'Stock by owner') => {
    const [rows] = await db.query(
      `SELECT x.item_id, x.owner_party_id, SUM(x.on_hand) AS on_hand, SUM(x.held) AS held, SUM(x.reserved) AS reserved FROM (
         SELECT k.item_id, b.owner_party_id, k.quantity AS on_hand, 0 AS held, 0 AS reserved
           FROM cf_stock_balances k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id AND a.purpose IN ('storage','wip')
           LEFT JOIN cf_stock_batches b ON b.id = k.batch_id
          WHERE k.company_id = ? AND k.item_id IN (?) AND k.quantity <> 0
         UNION ALL
         SELECT v.item_id, b.owner_party_id, 0, IF(v.held_for_order_id IS NOT NULL, v.quantity, 0), IF(v.requirement_id IS NOT NULL, v.quantity, 0)
           FROM cf_stock_reservations v LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
          WHERE v.company_id = ? AND v.item_id IN (?) AND v.status = 'active' AND v.deleted_at IS NULL) x
       GROUP BY x.item_id, x.owner_party_id ORDER BY x.item_id, x.owner_party_id`,
      [COMPANY, [G.A, G.B, G.C], COMPANY, [G.A, G.B, G.C]],
    );
    md.push(`**${label}**\n`);
    table(['Material', 'Owner', 'On hand', 'Earmarked to an MR', 'Reserved for production', 'Free'],
      rows.map((r) => [ITEM[r.item_id], r.owner_party_id ? names.get(Number(r.owner_party_id)) ?? `party ${r.owner_party_id}` : 'Ours', n(r.on_hand), n(r.held), n(r.reserved), n(Number(r.on_hand) - Number(r.held) - Number(r.reserved))]));
    return rows;
  };
  const poTable = (pos) => table(['PO', 'Vendor', 'Status', 'Line', 'Qty', 'Price', 'For'],
    pos.flatMap((p) => p.lines.map((l) => [p.code, (p.supplier?.name ?? '—').replace(`${tag} `, ''), p.status, l.item.code.replace(`${tag}-`, ''), n(l.quantity), l.unitPrice == null ? '—' : `₹${l.unitPrice}`,
      l.for.map((f) => `${f.requisition?.code ?? f.order.code} ×${n(f.quantity)}`).join(', ')])));
  const poLineOf = (po, itemId) => po.lines.find((l) => Number(l.item.id) === Number(itemId));
  const reservationsOfRelease = async (releaseId) => (await db.query(
    `SELECT v.item_id, v.batch_id, b.owner_party_id, SUM(v.quantity) AS q FROM cf_stock_reservations v JOIN cf_material_requirements q ON q.id = v.requirement_id
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND q.release_id = ? AND v.status = 'active' AND v.deleted_at IS NULL GROUP BY v.item_id, v.batch_id, b.owner_party_id ORDER BY v.item_id, v.batch_id`,
    [COMPANY, releaseId]))[0];
  const holdsOfLine = async (lineId) => (await db.query(
    `SELECT v.item_id, v.batch_id, b.owner_party_id, SUM(v.quantity) AS q FROM cf_stock_reservations v JOIN cf_requisition_lines prl ON prl.id = v.pr_line_id
       LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
      WHERE v.company_id = ? AND prl.order_line_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.held_for_order_id IS NOT NULL GROUP BY v.item_id, v.batch_id, b.owner_party_id ORDER BY v.item_id, v.batch_id`,
    [COMPANY, lineId]))[0];
  const sameRows = (a, b) => j(a.map((r) => [r.item_id, r.batch_id, r.owner_party_id, n(r.q)])) === j(b.map((r) => [r.item_id, r.batch_id, r.owner_party_id, n(r.q)]));
  /** What the release route does: release, then the MR's earmarks become its reservations. */
  const releaseFromMr = async (lineId) => {
    const check = await REL.releaseCheck(db, COMPANY, lineId);
    const rel = await REL.releaseLine(db, c, lineId, { finishedAreaId: G.dispatch, view: 'none' });
    const fromMr = await REL.takeMrEarmarks(db, c, rel.id);
    return { check, rel, fromMr };
  };
  const receive = (itemId, quantity) => ST.postMovement(db, c, { movementType: 'receipt', toAreaId: G.store, lines: [{ itemId, quantity, unitCost: 10 }] });

  md.push(`# Material request (MR) flow — a scripted run\n`);
  md.push(`Run \`${tag}\` on the local database, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (the engine's "today" is ${TODAY}). `
    + 'Everything happened inside ONE database transaction that was rolled back at the end, so nothing of it is left behind. '
    + `Made by \`multi_app_be/scripts/cf_kepl/mr_flow_test.mjs\`. Each girder needs A 4 kg, B 6 kg, C 5 kg. `
    + 'In the tables: **Earmarked** = held for the MR line (from stock, or received on its PO); **On PO** = still to come on a live purchase order; '
    + '**Received** = arrived on its POs; **Open** = nothing covers it yet.\n');

  /* ════════════════════════════════════ A. WE BUY ════════════════════════════════════ */
  step('A0. Stock before anything', 'Our own stock: A 5 kg and C 10 kg. Customer Y has 20 kg of A in our store for one of its orders (their lot — not ours).');
  await receive(G.A, 5);
  await receive(G.C, 10);
  const Y = await makeOrder('Y', [1], { customer: CUS_Y });
  await OWN.receiveCustomerMaterial(db, c, { orderId: Y.id, toAreaId: G.store, lines: [{ itemId: G.A, quantity: 20 }] });
  await stockByOwner();

  step('A1. Order captured as "We buy", locked; the MR is raised (stock earmarked at once)');
  const W = await makeOrder('WEBUY', [1, 1]);
  ok('the order is created with material supply "We buy" (the default)', W.supply === 'we_buy', W.supply);
  const raised = await RQ.raiseRequisitions(db, c, W.id, { earmark: true });
  const mrW = raised.requisitions;
  ok('two MRs, one per line, numbered MR-<order>-<line>', mrW.length === 2 && mrW.every((r) => r.code === `MR-${W.code}-${r.line.lineNo}`) && mrW.every((r) => r.supply === 'we_buy'), j(mrW.map((r) => [r.code, r.supply])));
  say(`Raised ${mrW.map((r) => r.code).join(' and ')}; earmarked at once: ${raised.earmarked.map((e) => `${e.requisition.code} ${e.item.code.replace(`${tag}-`, '')} ${n(e.quantity)}`).join(', ')}.`);
  let s = await stateOf(W.id);
  const [W1, W2] = s;
  ok('line 1 takes A 4 (claim order), line 2 the last 1 of our A — A is open 3 on MR 2', mrLine(W1, G.A).cover.earmarked === 4 && mrLine(W2, G.A).cover.earmarked === 1 && mrLine(W2, G.A).cover.open === 3, j(s.map((r) => mrLine(r, G.A).cover)));
  ok('C is earmarked wholly (5 + 5); B is open on both (6 + 6)', mrLine(W1, G.C).cover.earmarked === 5 && mrLine(W2, G.C).cover.earmarked === 5 && mrLine(W1, G.B).cover.open === 6 && mrLine(W2, G.B).cover.open === 6);
  ok("customer Y's 20 kg of A is NOT earmarked for this order", (await availability(db, COMPANY, [G.A], { orderId: Y.id })).get(G.A).theirsFree === 20);
  await stockByOwner();

  step('A2. Two purchase orders to match what is open — PO 1 serves BOTH MRs');
  const po1 = (await RQ.makePurchaseOrders(db, c, { orders: [{ supplierId: S1, place: true, expectedDate: D(10), lines: [
    { prLineId: mrLine(W2, G.A).id, quantity: 3 }, { prLineId: mrLine(W1, G.B).id, quantity: 6 }, { prLineId: mrLine(W2, G.B).id, quantity: 4 }] }] })).purchaseOrders[0];
  const po2 = (await RQ.makePurchaseOrders(db, c, { orders: [{ supplierId: S2, place: true, expectedDate: D(20), lines: [{ prLineId: mrLine(W2, G.B).id, quantity: 2 }] }] })).purchaseOrders[0];
  poTable([po1, po2]);
  s = await stateOf(W.id);
  ok('nothing is open on either MR now', s.every((r) => r.lines.every((l) => l.cover.open === 0)), j(s.map((r) => r.lines.map((l) => l.cover.open))));
  ok('PO 1 serves two MRs (its B line is for MR 1 and MR 2)', poLineOf(po1, G.B).for.length === 2 && new Set(poLineOf(po1, G.B).for.map((f) => f.requisition?.code)).size === 2);

  step('A3. PO 2 is CANCELLED — the MR opens again by itself');
  const gone = await PS.cancelPurchaseOrder(db, c, po2.id, { reason: 'supplier fell through' });
  ok('the PO is cancelled', gone.status === 'cancelled');
  s = await stateOf(W.id);
  ok('MR 2 · B: 2 kg open again, with no other step', mrLine(s[1], G.B).cover.open === 2 && mrLine(s[1], G.B).cover.onPo === 4, j(mrLine(s[1], G.B).cover));
  ok('…and the MR still lists the cancelled PO, as closed', mrLine(s[1], G.B).purchase.some((p) => p.purchaseOrder.id === po2.id && p.state === 'closed'));
  const [[{ live }]] = await db.query('SELECT COUNT(*) AS live FROM cf_purchase_line_orders a JOIN cf_purchase_order_lines l ON l.id = a.purchase_line_id WHERE l.purchase_order_id = ? AND a.deleted_at IS NULL', [po2.id]);
  ok("the cancelled PO's shares are dropped (no live share left)", Number(live) === 0);
  ok("the cancelled PO still says what it was for (for the record)", (await PS.getPurchaseOrder(db, COMPANY, po2.id)).lines[0].orders.length === 1);
  say(`${po2.code} cancelled → MR 2 · B shows 2 kg open again.`);

  step('A3b. A PO LINE cut (quantity down) also gives back to the MR');
  const pB = poLineOf(po1, G.B);
  await PS.updatePurchaseLine(db, c, pB.id, { quantity: 9 });
  s = await stateOf(W.id, 'PO 1 · B cut from 10 to 9 — the newest share gives way:');
  ok('cutting PO 1 · B by 1 opens 1 on MR 2 · B (the newest share)', mrLine(s[1], G.B).cover.open === 3 && mrLine(s[0], G.B).cover.open === 0, j(s.map((r) => mrLine(r, G.B).cover.open)));
  await PS.updatePurchaseLine(db, c, pB.id, { quantity: 10 });
  await PS.setPurchaseLineOrders(db, c, pB.id, { orders: [...(await PS.getPurchaseOrder(db, COMPANY, po1.id)).lines.find((l) => l.id === pB.id).orders.map((a) => ({ orderId: a.orderId, prLineId: a.prLineId, quantity: a.quantity + (a.prLineId === mrLine(W2, G.B).id ? 1 : 0) }))] });
  s = await stateOf(W.id, 'Put back to 10 for MR 1 6 + MR 2 4:');
  ok('…put back, MR 2 · B is open 2 again (what PO 2 had)', mrLine(s[1], G.B).cover.open === 2, j(mrLine(s[1], G.B).cover));

  step('A4. A new PO covers what the cancelled one had');
  const po3 = (await RQ.makePurchaseOrders(db, c, { orders: [{ supplierId: S2, place: true, expectedDate: D(25), lines: [{ prLineId: mrLine(W2, G.B).id }] }] })).purchaseOrders[0];
  poTable([po3]);
  s = await stateOf(W.id);
  ok('the new PO takes exactly what was open (2 kg)', poLineOf(po3, G.B).quantity === 2 && s.every((r) => r.lines.every((l) => l.cover.open === 0)));

  step('A5. Partial GRN on PO 1 (it serves two MRs) — earmarked to the MRs, oldest share first');
  const g1 = await PS.receiveLine(db, c, poLineOf(po1, G.B).id, { quantity: 8, stockingAreaId: G.store });
  say(`GRN ${g1.movement.code}: 8 kg of B on ${po1.code} → ${g1.held.map((h) => `${h.orderCode} ${n(h.quantity)} (MR line ${h.prLineId})`).join(', ')}.`);
  s = await stateOf(W.id);
  ok('MR 1 · B: its 6 kg share arrived first → earmarked 6, nothing on PO', mrLine(s[0], G.B).cover.earmarked === 6 && mrLine(s[0], G.B).cover.onPo === 0 && mrLine(s[0], G.B).cover.received === 6);
  ok('MR 2 · B: 2 of its 4 on PO 1 arrived → earmarked 2, still 2 on PO 1 + 2 on the new PO', mrLine(s[1], G.B).cover.earmarked === 2 && mrLine(s[1], G.B).cover.onPo === 4 && mrLine(s[1], G.B).cover.received === 2, j(mrLine(s[1], G.B).cover));
  await stockByOwner();

  step('A6. Full GRN — every MR line is earmarked');
  await PS.receiveLine(db, c, poLineOf(po1, G.B).id, { quantity: 2, stockingAreaId: G.store });
  await PS.receiveLine(db, c, poLineOf(po1, G.A).id, { quantity: 3, stockingAreaId: G.store });
  await PS.receiveLine(db, c, poLineOf(po3, G.B).id, { stockingAreaId: G.store });
  s = await stateOf(W.id);
  ok('every MR line: earmarked = need, nothing on PO, nothing open — "From stock"', s.every((r) => r.lines.every((l) => l.cover.earmarked === l.need && l.cover.onPo === 0 && l.cover.open === 0)) && s.every((r) => r.status === 'fulfilled_from_stock'), j(s.map((r) => r.status)));
  const ready = await MRS.lineReadiness(db, COMPANY, { full: true });
  ok('the engine: both lines ready (their material is here)', W.lines.every((l) => ready.byLine.get(l.id)?.state === 'ready'), j(W.lines.map((l) => ready.byLine.get(l.id)?.state)));
  await stockByOwner();

  step('A7. Release — the production order takes its material from the MR');
  const holdsW1 = await holdsOfLine(W.lines[0].id);
  const r1 = await releaseFromMr(W.lines[0].id);
  ok('release check allowed the line', r1.check.ok === true, j(r1.check.problems?.slice(0, 3)));
  const res1 = await reservationsOfRelease(r1.rel.id);
  ok(`"Material from ${r1.fromMr.requisition?.code}": the release's reservations = the MR's earmarks, lot by lot`, r1.fromMr.requisition?.code === W1.code && sameRows(res1, holdsW1), j([res1, holdsW1]));
  ok('…and the MR holds are used up (consumed), nothing left earmarked twice', (await holdsOfLine(W.lines[0].id)).length === 0);
  say(`Released line 1: Material from ${r1.fromMr.requisition.code} — ${r1.fromMr.reserved.map((x) => `${x.item.code.replace(`${tag}-`, '')} ${n(x.quantity)}`).join(', ')} reserved for production.`);
  const holdsW2 = await holdsOfLine(W.lines[1].id);
  const r2 = await releaseFromMr(W.lines[1].id);
  ok('line 2 the same', sameRows(await reservationsOfRelease(r2.rel.id), holdsW2));
  s = await stateOf(W.id, 'The MRs after release (earmarks are now reservations — still the MR\'s cover):');
  ok('the MRs still show their material covered (reserved)', s.every((r) => r.lines.every((l) => l.cover.open === 0)));
  await stockByOwner();
  const back = await REL.unrelease(db, c, r2.rel.id);
  ok('unrelease puts line 2\'s reservations back on its MR as earmarks (the reverse)', back.ok === true && sameRows(await holdsOfLine(W.lines[1].id), holdsW2));
  const r2b = await releaseFromMr(W.lines[1].id);
  ok('…and releasing again takes them again', sameRows(await reservationsOfRelease(r2b.rel.id), holdsW2));

  /* ═════════════════════════════ B. NOT TRACKED IN NESTING ═════════════════════════════ */
  step('B. Pieces not tracked in nesting (cut from untracked offcuts) put nothing on the MR',
    'A nested line (plates from the nest). The gusset plate is left out of the nesting: its 6 gussets have no plate. Then they are marked "cut from untracked offcuts" — small parts made from whatever is lying around.');
  const fx = await NF.buildFixture(db, { company: COMPANY, tagPrefix: 'TMRN' });
  await db.query('UPDATE cf_sales_orders SET code = ? WHERE id = ?', [`${tag}-NEST`, fx.orderId]);
  // What lock does to the line: its rows rolled out into cf_order_pieces (as plate_change_test does).
  {
    const [bl] = await db.query(
      `SELECT b.parent_id, l.id, l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, [fx.root, ...Object.values(fx.partRow)]]);
    const lineOf = (parent, child) => bl.find((x) => Number(x.parent_id) === Number(parent) && Number(x.child_id) === Number(child))?.id ?? null;
    let sort = 0;
    const piece = async (parentId, itemId, bomLineId, qty, depth) => (await db.query(
      'INSERT INTO cf_order_pieces (company_id, order_id, order_line_id, parent_id, item_id, bom_line_id, quantity, code, path_key, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [COMPANY, fx.orderId, fx.lineId, parentId, itemId, bomLineId, qty, `${fx.tag}-PCE-${sort}`, `${fx.tag}/${sort}`, depth, sort++],
    ))[0].insertId;
    const root = await piece(null, fx.root, null, 1, 0);
    for (const [sfx, p] of Object.entries(fx.parts)) {
      const row = await piece(root, fx.partRow[sfx], lineOf(fx.root, fx.partRow[sfx]), p.qty, 1);
      await piece(row, fx.cut[sfx], lineOf(fx.partRow[sfx], fx.cut[sfx]), p.qty, 2);
    }
  }
  const sets = NF.nestings(fx);
  const asReq = (files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
  const up = await NU.uploadNestFiles(db, c, fx.lineId, { files: asReq(sets.B.filter((f) => !f.filename.includes('-B4_'))), dryRun: false });
  ok(`nested: ${up.saved?.lots} plates; the gussets left over`, up.applied === true && up.leftOver.length === 1 && up.leftOver[0].cutPlateId === fx.cut.G, j(up.leftOver));
  const needOf = async () => (await MRS.lineNeeds(db, COMPANY, await MRS.openLines(db, COMPANY, { orderIds: [fx.orderId] }))).get(fx.lineId);
  const nb = await needOf();
  md.push(`Before marking: the line needs ${[...nb.items.values()].map((e) => `${e.item.code.replace(`${fx.tag}-`, '')} ${n(e.need)}`).join(', ')}${nb.ready ? '' : ` — and says: "${nb.why}"`}
`);
  const ub = await UT.markUntracked(db, c, fx.lineId, {});
  say(ub.message);
  const na = await needOf();
  const plateIds = new Set(Object.values(fx.plates).map(Number));
  md.push(`After marking: the line needs ${[...na.items.values()].map((e) => `${e.item.code.replace(`${fx.tag}-`, '')} ${n(e.need)}`).join(', ')}.
`);
  const ps = Number(fx.plates.PS);
  ok('before marking, the left-over gussets still asked for a share of a PS plate (their plate line)', (nb.items.get(ps)?.need ?? 0) > (na.items.get(ps)?.need ?? 0) + EPS, j([nb.items.get(ps)?.need, na.items.get(ps)?.need]));
  ok('after marking, the line needs exactly the whole plates of the nest (the marked gussets ask for nothing)', [...na.items.values()].every((e) => Math.abs(e.need - Math.round(e.need)) < EPS), j([...na.items.values()].map((e) => e.need)));
  ok('after marking: every material the line needs is a nest PLATE — nothing for the marked gussets', na.items.size > 0 && [...na.items.keys()].every((id) => plateIds.has(Number(id))), j([...na.items.values()].map((e) => e.item.code)));
  ok('…the need is complete (no "cut plate with no plate yet")', na.ready === true && na.known === true, j([nb.ready, na.ready, na.why]));
  const rn = await RQ.raiseRequisitions(db, c, fx.orderId, {});
  const mrN = rn.requisitions[0];
  table(['MR', 'Material', 'Need', 'Status'], mrN.lines.map((l) => [mrN.code, l.item.code.replace(`${fx.tag}-`, ''), n(l.need), l.statusLabel]));
  ok('the MR lists the nest plates only', mrN.lines.length > 0 && mrN.lines.every((l) => plateIds.has(Number(l.item.id))), j(mrN.lines.map((l) => l.item.code)));
  ok('no MR line names the gusset (or any cut plate)', !mrN.lines.some((l) => Number(l.item.id) === Number(fx.cut.G)));
  const engN = (await MRS.lineReadiness(db, COMPANY, { full: true })).byLine.get(fx.lineId);
  ok('the engine waits only for the plates — no reason names a marked piece', engN && engN.reasons.every((r) => plateIds.has(Number(r.item.id))), j(engN?.reasons.map((r) => r.item.code)));

  /* ═════════════════════════════ C. CUSTOMER SUPPLIES ═════════════════════════════ */
  step('C0. Order captured as "Customer supplies"', 'Customer X will send the steel. They have already sent 2 kg of A for this order before the MR. We also have 10 kg of our own A free.');
  const X = await makeOrder('CUST', [1], { customer: CUS_X, materialSupply: 'customer' });
  ok('the order is created with material supply "Customer supplies"', X.supply === 'customer');
  await OWN.receiveCustomerMaterial(db, c, { orderId: X.id, toAreaId: G.store, lines: [{ itemId: G.A, quantity: 2 }] });
  await receive(G.A, 10);
  const oursFreeA = (await availability(db, COMPANY, [G.A])).get(G.A).free;
  await stockByOwner();

  step('C1. The MR is raised — the customer\'s own lot is earmarked, and a PO to the CUSTOMER as vendor is made by itself');
  const rx = await RQ.raiseRequisitions(db, c, X.id, {});
  const mrX = rx.requisitions[0];
  ok('the MR is "Customer supplies"', mrX.supply === 'customer' && mrX.code === `MR-${X.code}-1`, j([mrX.code, mrX.supply]));
  ok("their 2 kg of A is earmarked to it; none of ours", rx.earmarked.length === 1 && rx.earmarked[0].owner === 'customer' && rx.earmarked[0].quantity === 2, j(rx.earmarked));
  const cpo = rx.customerPurchaseOrders[0];
  ok('ONE PO was made by itself, to the customer as vendor, placed, ₹0', rx.customerPurchaseOrders.length === 1 && cpo.supplier.id === CUS_X && cpo.status === 'ordered' && cpo.suppliedByCustomer === true && cpo.lines.every((l) => l.unitPrice === 0), j(cpo));
  ok('…for exactly what is still open: A 2, B 6, C 5', n(poLineOf(cpo, G.A).quantity) === '2' && n(poLineOf(cpo, G.B).quantity) === '6' && n(poLineOf(cpo, G.C).quantity) === '5');
  poTable([cpo]);
  let sx = await stateOf(X.id);
  ok('our own free A is untouched by the customer MR', (await availability(db, COMPANY, [G.A])).get(G.A).free === oursFreeA);
  const ex = (await MRS.lineReadiness(db, COMPANY, { full: true })).byLine.get(X.lines[0].id);
  ok("the engine WAITS — it does not lean on our free stock for the customer's material", ex.state === 'waiting' && !ex.reasons.some((r) => r.cover.some((x) => x.kind === 'free' && x.owner !== 'customer')), j(ex.reasons.map((r) => [r.item.code, r.cover])));
  say(`Customer PO ${cpo.code} to ${names.get(CUS_X)}: ${cpo.lines.map((l) => `${l.item.code.replace(`${tag}-`, '')} ${n(l.quantity)}`).join(', ')} at ₹0.`);

  step('C2. Who supplies it is fixed once the MR is raised');
  let e = await refusal(() => SO.updateOrder(db, c, X.id, { materialSupply: 'we_buy' }));
  ok('the order cannot switch to "We buy" now', /fixed once a material request is raised/.test(j([e?.message, e?.problems])), j([e?.message, e?.problems]));
  say(`Order → "We buy": refused — ${(e.problems ?? [e.message]).join(' ')}`);
  e = await refusal(() => SO.setLineSupply(db, c, X.lines[0].id, { supply: 'we_buy' }));
  ok('nor the line', !!e && /is raised/.test(j(e.problems ?? e.message)), j(e?.problems ?? e?.message));
  say(`Line 1 → "We buy": refused — ${(e.problems ?? [e.message]).join(' ')}`);
  e = await refusal(() => RQ.makePurchaseOrders(db, c, { orders: [{ supplierId: S1, place: true, lines: [{ prLineId: mrLine(mrX, G.B).id, quantity: 1 }] }] }));
  ok('a supplier PO for the customer MR is refused', !!e && /supplied by the customer/.test(j(e.problems)), j(e?.problems));
  say(`A PO to a supplier for it: refused — ${e.problems.join(' ')}`);
  const Z = await makeOrder('LINEOVR', [1]);
  const lo = await SO.setLineSupply(db, c, Z.lines[0].id, { supply: 'customer' });
  ok('before its MR, a line of a "We buy" order may say "Customer supplies"', lo.supply === 'customer' && lo.materialSupply === 'customer');
  const z0 = (await RQ.orderRequisitions(db, COMPANY, Z.id)).linesWithout[0];
  ok('…the line without an MR shows it', z0.supply === 'customer' && z0.ownSupply === 'customer', j(z0));
  await SO.setLineSupply(db, c, Z.lines[0].id, { supply: null });
  ok('…and back to "as the order"', (await RQ.orderRequisitions(db, COMPANY, Z.id)).linesWithout[0].supply === 'we_buy');
  say(`Before its MR, line 1 of ${Z.code} ("We buy") was set to "Customer supplies" and back — allowed.`);

  step('C3. The customer PO is cancelled → the MR opens again; brought up to date → a new customer PO');
  await PS.cancelPurchaseOrder(db, c, cpo.id, { reason: 'customer re-issued the steel list' });
  sx = await stateOf(X.id);
  ok('B 6 and C 5 and A 2 are open again on the MR', mrLine(sx[0], G.B).cover.open === 6 && mrLine(sx[0], G.C).cover.open === 5 && mrLine(sx[0], G.A).cover.open === 2, j(sx[0].lines.map((l) => l.cover.open)));
  const rx2 = await RQ.raiseRequisitions(db, c, X.id, {});
  const cpo2 = rx2.customerPurchaseOrders[0];
  ok('bringing the MR up to date asks the customer again — a new PO for what is open', rx2.raised === 0 && rx2.refreshed === 1 && cpo2 && cpo2.id !== cpo.id && cpo2.suppliedByCustomer, j(rx2.customerPurchaseOrders));
  poTable([cpo2]);
  const rx3 = await RQ.raiseRequisitions(db, c, X.id, {});
  ok('…and again: nothing open → no further PO', rx3.customerPurchaseOrders.length === 0);
  await PS.updatePurchaseLine(db, c, poLineOf(cpo2, G.B).id, { expectedDate: D(5) });
  await stateOf(X.id);

  step('C4. GRN on the customer PO — the CUSTOMER\'s lots, earmarked to the MR');
  const gx = await PS.receiveLine(db, c, poLineOf(cpo2, G.B).id, { quantity: 4, stockingAreaId: G.store });
  const lotOf = async (movementId) => (await db.query('SELECT b.id, b.code, b.owner_party_id, b.owner_order_id, b.unit_cost FROM cf_stock_ledger k JOIN cf_stock_batches b ON b.id = k.batch_id WHERE k.movement_id = ?', [movementId]))[0][0];
  const lotB = await lotOf(gx.movement.id);
  ok(`the receipt made a lot owned by customer X, for this order, not costed as ours (${lotB?.code})`, Number(lotB?.owner_party_id) === CUS_X && Number(lotB?.owner_order_id) === X.id && lotB.unit_cost == null, j(lotB));
  sx = await stateOf(X.id, 'After a partial GRN (B 4 of 6):');
  ok('MR · B: 4 earmarked, 2 still on the customer PO', mrLine(sx[0], G.B).cover.earmarked === 4 && mrLine(sx[0], G.B).cover.onPo === 2);
  await PS.receiveLine(db, c, poLineOf(cpo2, G.B).id, { stockingAreaId: G.store });
  await PS.receiveLine(db, c, poLineOf(cpo2, G.C).id, { stockingAreaId: G.store });
  await PS.receiveLine(db, c, poLineOf(cpo2, G.A).id, { stockingAreaId: G.store });
  sx = await stateOf(X.id, 'After the full GRN:');
  ok('every line of the customer MR is earmarked, nothing open', sx[0].lines.every((l) => l.cover.earmarked === l.need && l.cover.open === 0) && sx[0].status === 'fulfilled_from_stock', j(sx[0].lines.map((l) => l.cover)));
  const holdsX = await holdsOfLine(X.lines[0].id);
  ok("every earmark of the customer MR sits on the customer's own lots", holdsX.length > 0 && holdsX.every((h) => Number(h.owner_party_id) === CUS_X), j(holdsX));
  // One more piece the customer sent: their lot, earmarked to nobody (for the next check).
  await OWN.receiveCustomerMaterial(db, c, { orderId: X.id, toAreaId: G.store, lines: [{ itemId: G.B, quantity: 3 }] });
  await stockByOwner();

  step('C5. Another order does not see the customer\'s material');
  const O2 = await makeOrder('OTHER', [1], { customer: CUS_Y });
  const r2o = await RQ.raiseRequisitions(db, c, O2.id, {});
  const dry = await RQ.stockCheck(db, c, r2o.requisitions[0].id, {});
  const bRow = dry.lines.find((l) => Number(l.item.id) === G.B);
  ok("another customer's order: its stock check finds NO B free — customer X's 3 kg lot is invisible to it", bRow.freeInStock === 0, j(bRow));
  ok("…and our own stock check (no order) counts only ours", (await availability(db, COMPANY, [G.B])).get(G.B).free === 0);
  const eo = (await MRS.lineReadiness(db, COMPANY, { full: true })).byLine.get(O2.lines[0].id);
  ok("the engine: the other order's B waits — X's lot is not free for it", eo.reasons.find((r) => Number(r.item.id) === G.B)?.short === 6, j(eo.reasons.find((r) => Number(r.item.id) === G.B)));
  table(['Order', 'Material', 'Free for it in stock (stock check)'], [[O2.code, 'B', n(bRow.freeInStock)], [O2.code, 'A (ours, free)', n(dry.lines.find((l) => Number(l.item.id) === G.A).freeInStock)]]);

  step('C6. Release the customer-supplied line — reservations = the MR\'s earmarks (their lots only)');
  const oursBefore = (await availability(db, COMPANY, [G.A, G.B, G.C]));
  const rx4 = await releaseFromMr(X.lines[0].id);
  const resX = await reservationsOfRelease(rx4.rel.id);
  ok(`"Material from ${rx4.fromMr.requisition?.code}": reservations = the MR's earmarks`, sameRows(resX, holdsX), j([resX, holdsX]));
  ok("every reservation is on customer X's lots", resX.every((r) => Number(r.owner_party_id) === CUS_X));
  await REL.reserveRelease(db, c, rx4.rel.id, { view: 'none' });
  ok('"Reserve all" afterwards takes nothing of ours for the customer material (nothing more is needed)', sameRows(await reservationsOfRelease(rx4.rel.id), holdsX));
  const oursAfter = (await availability(db, COMPANY, [G.A, G.B, G.C]));
  ok('our own free stock is exactly what it was', [G.A, G.B, G.C].every((i) => oursAfter.get(i).free === oursBefore.get(i).free), j([...oursAfter].map(([k, v]) => [k, v.free])));
  say(`Released: Material from ${rx4.fromMr.requisition.code} — ${rx4.fromMr.reserved.map((x) => `${x.item.code.replace(`${tag}-`, '')} ${n(x.quantity)}`).join(', ')} of customer X's own steel reserved for production.`);
  await stockByOwner();

  step('C7. Inventory by owner — ours apart from each customer\'s');
  const list = await ST.listStock(db, COMPANY, { paged: '1', search: tag, pageSize: '200' });
  const xs = list.counts.owners.parties.find((p) => Number(p.id) === CUS_X);
  ok("the stock list's owner chips: Ours, and customer X with its lines", list.counts.owners.ours > 0 && !!xs, j(list.counts.owners));
  const onlyX = await ST.listStock(db, COMPANY, { paged: '1', search: tag, owner: String(CUS_X), pageSize: '200' });
  ok("filtered to customer X: only X's lots", onlyX.rows.length > 0 && onlyX.rows.every((r) => Number(r.owner?.party?.id) === CUS_X), j(onlyX.rows.map((r) => r.owner)));
  const val = await VAL.stockValuation(db, COMPANY, { groupBy: 'owner', itemId: G.B });
  const vx = val.groups.find((g) => g.key === `party:${CUS_X}`);
  ok("valuation: customer X's B is under customers, not in our value", vx && vx.ours.quantity === 0 && vx.customers.quantity > 0, j(val.groups));
  table(['Owner', 'Stock lines', 'Held for them (per unit)'], [['Ours', String(list.counts.owners.ours), '—'],
    ...list.counts.owners.parties.map((p) => [p.name.replace(`${tag} `, ''), String(p.n), list.counts.held.filter((h) => Number(h.partyId) === Number(p.id)).map((h) => `${n(h.quantity)} ${h.uom}`).join(', ')])]);

  // ── the end ─────────────────────────────────────────────────────────────────────────────────
  await db.rollback();
  detachNodeCache(db);
  const after = await H.counts();
  const changed = after.filter((a) => Number(before.find((b) => b.name === a.name)?.n) !== Number(a.n));
  ok('ROLLED BACK: every cf_ table has exactly the rows it had', changed.length === 0, j(changed));
} catch (e) {
  try { await db.rollback(); } catch { /* already */ }
  console.error(e);
  H.state.failed += 1; H.state.fails.push(`threw: ${e.message}`);
  md.push(`\n**The run stopped with an error:** ${e.message}\n`);
} finally {
  db.release();
  md.push(`\n## Result\n\n${H.state.passed} checks passed, ${H.state.failed} failed.${H.state.fails.length ? `\n\nFailed:\n${H.state.fails.map((f) => `- ${f}`).join('\n')}` : ''}\n`);
  fs.writeFileSync(TRANSCRIPT, `${md.join('\n')}\n`);
  console.log(`\n${H.state.passed} passed, ${H.state.failed} failed — transcript ${TRANSCRIPT}`);
  await pool.end();
  process.exit(H.state.failed ? 1 : 0);
}
