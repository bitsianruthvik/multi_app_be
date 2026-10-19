/**
 * accounts_test.mjs — STEP 3B of the CF_ERP redesign (init.sql §74, TM/s74.sql; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Step 3B"): ACCOUNTS — the Billing board, milestone invoices (GST), receipts, order costing, and
 * "Used for" on every issue from stock.
 *
 *   cd multi_app_be && node scripts/cf_kepl/accounts_test.mjs
 *   CF_ACCT_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own
 * (TEST-ACCT-<run>). Line 923 is never touched. A state table of the cards is written per step to TM/ACCOUNTS_RUN.md.
 *
 *   1  an accepted order (TEST-ACCT-A) with charges (weight pro-rata, formula on completion, material, a lump sum) and
 *      eight milestones of different triggers → the board: advance DUE, the rest UPCOMING
 *   2  MR material locked in two goes (observed by the board) → pro-rata weekly cards
 *   3  the fabrication operation completed over two weeks → one card a week; due on the week's Sunday
 *   4  dispatch per lot → a card per dispatch; fully dispatched → "30 days after" and retention dated
 *   5  the post-production stage ticked → its milestone due; a fixed date → due on the day
 *   6  raise a GST invoice of two due cards (intra-state: CGST + SGST), numbered from the year's series; billed
 *   7  receipts: part payment (still billed, outstanding), then the rest (paid); overdue after the credit days
 *   8  an inter-state customer (TEST-ACCT-B): IGST
 *   9  order costing: material (MR item issued), consumables (issued "Used for" the order), scrap credit, margin
 *  10  every issue says what it is used for (refused without; General accepted)
 *  11  the order closes only when the stages are done AND it is fully paid
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const ACC = await imp('apps/cf_erp/services/acceptanceService.js');
const AP = await imp('apps/cf_erp/services/approvalService.js');
const BOARD = await imp('apps/cf_erp/services/orderBoardService.js');
const BILL = await imp('apps/cf_erp/services/billingService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const RC = await imp('apps/cf_erp/services/receiptService.js');
const COST = await imp('apps/cf_erp/services/costingService.js');
const INV = await imp('apps/cf_erp/services/invoiceService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PRS = await imp('apps/cf_erp/services/purchaseRequestService.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const TAX = await imp('apps/cf_erp/services/taxService.js');
const SCRAP = await imp('apps/cf_erp/services/scrapService.js');
const { writeTransform } = await imp('apps/cf_erp/services/productionLedgerService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { gstinCheckChar } = await imp('apps/cf_erp/modules/parties/gstin.js');
const { harness, girder, simple, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_ACCT_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-ACCT-${RUN}`;
const H = harness(pool);
const { ok, section, refusal, j } = H;
const near = (a, b, tol = 0.011) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const gstin = (first14) => first14 + gstinCheckChar(first14);
const before = await H.counts();
const db = await pool.getConnection();
const all = () => true;
const T = BILL.todayText();
const MON = BILL.weekOf(T);
const LAST_WEEK = BILL.addDays(T, -7);
const NEXT_MONDAY = BILL.addDays(MON, 7);
const runLog = [`# ACCOUNTS_RUN — step 3B test run ${tag}`, '', `Run on ${T} (today). Every table is the Billing board's cards of the run's orders at that step.`, ''];

/** A state table of the board's cards (one order or all of the run's). */
function table(title, board, note = '') {
  const rows = board.lanes.flatMap((l) => l.cards).sort((a, b) => a.orderCode.localeCompare(b.orderCode) || a.milestone.key.localeCompare(b.milestone.key) || String(a.partKey).localeCompare(String(b.partKey)));
  runLog.push(`## ${title}`, '');
  if (note) runLog.push(note, '');
  runLog.push(`Board read as of ${board.today}.`, '', '| Order | Milestone | Part | Amount ₹ | Lane | Due on | Invoice | Outstanding ₹ | Overdue |', '|---|---|---|---:|---|---|---|---:|---|');
  for (const c of rows) {
    runLog.push(`| ${c.orderCode.replace(`${tag}-`, '')} | ${c.milestone.key} ${c.milestone.label} | ${c.partKey}${c.note ? ` — ${c.note}` : ''} | ${c.amount.toLocaleString('en-IN')} | ${c.status} | ${c.dueOn ?? '—'} | ${c.invoice?.invoiceNo ?? ''} | ${c.invoice ? c.invoice.outstanding.toLocaleString('en-IN') : ''} | ${c.overdue ? `yes (${c.daysOverdue} d)` : ''} |`);
  }
  runLog.push('');
}
const cardsOf = (board, orderId) => board.lanes.flatMap((l) => l.cards).filter((c) => c.orderId === orderId);
const find = (board, orderId, mKey, partKey = null) => cardsOf(board, orderId).filter((c) => c.milestone.key === mKey && (partKey == null || c.partKey === partKey));

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const [users] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY]);
  if (users.length < 2) throw new Error('The suite needs two users in the company (requester and approver).');
  const c = { companyId: COMPANY, userId: users[0].id };
  const md = { companyId: COMPANY, userId: users[1].id };
  const asMd = { can: all, isAdmin: false };
  await quietCodes(db, COMPANY, ['purchase_order', 'sales_order', 'stock_movement', 'tax_invoice']);
  const [[l923]] = await db.query('SELECT id, locked_at, (SELECT COUNT(*) FROM cf_production_releases r WHERE r.order_line_id = 923 AND r.deleted_at IS NULL) AS rel FROM cf_sales_order_lines WHERE id = 923');

  // ── fixture ──────────────────────────────────────────────────────────────────────────────────
  const G = await girder(db, c, tag);
  const S = await simple(db, c, `${tag}S`);
  const fab = await OPS.createOperation(db, c, { code: `${tag}-FAB`, name: `Fabrication ${tag}` });
  const paint = await OPS.createOperation(db, c, { code: `${tag}-PNT`, name: `Painting ${tag}` });
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const spec = (code, name, uom) => ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, 'number', ?, 'active')", [COMPANY, code, name, uom]);
  const SA = `TSA${RUN}`; const COATS = `TCO${RUN}`;
  const saId = await spec(SA, `Surface area ${tag}`, 'm2');
  const coatsId = await spec(COATS, `Coats ${tag}`, null);
  const [[weightSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const prc = await PROC.createProcess(db, c, { code: `${tag}-PRC`, name: `Accounts test ${tag}` });
  await PROC.replaceStages(db, c, prc.id, { stages: ['structure', 'lock', 'nesting', 'buying', 'acceptance', 'production'].map((stageKey) => ({ stageKey })) });
  await PROC.setProcessStatus(db, c, prc.id, 'active');
  // GST: the company in Maharashtra; the girder template's HSN 7308 at 18 %; the customer in Maharashtra (intra-state).
  await db.query("UPDATE cf_company_settings SET invoice_prefix = 'INV' WHERE company_id = ?", [COMPANY]);
  await TAX.putTaxSettings(db, c, { legalName: `${tag} Fabricators Pvt Ltd`, tradeName: `${tag} Fab`, gstin: '27aapfu0939f1zv', address1: 'Plot 12, MIDC Bhosari', city: 'Pune', pincode: '411026', invoicePrefix: 'INV' });
  await db.query('DELETE FROM cf_invoice_series WHERE company_id = ?', [COMPANY]);
  await MR.updateRecord(db, c, G.GR.id, { hsnCode: '7308', gstRate: 18 });
  await db.query("UPDATE cf_parties SET tax_number = ?, gst_registration = 'regular', state_code = '27', address = 'Station Road', city = 'Nagpur', pincode = '440001' WHERE id = ?", [gstin('27AABCR1234K1Z'), G.CUS]);
  const KA = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status, tax_number, gst_registration, state_code, address, city, pincode) VALUES (?, ?, ?, 1, 'active', '29AAGCB7383J1Z4', 'regular', '29', 'MG Road', 'Bengaluru', '560001')", [COMPANY, `${tag}-KA`, `${tag} Karnataka customer`]);

  /** An inquiry for `qty` girders, frozen, on the acceptance process; WEIGHT 2000 kg a girder; part areas; 3 coats. */
  const makeOrder = async (key, qty) => {
    const o = await G.girderOrder(key, qty, { status: 'inquiry', lock: true });
    await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, o.id]);
    // The lock is written with MySQL NOW(), the SERVER's wall clock; the pool reads DATETIMEs as UTC ('Z', db.js). On a
    // local IST server that reads back 5½ h late — after 18:30 the freeze lands TOMORROW and "design frozen" is not due
    // yet (2026-10-18: "fails on local data"; prod is UTC throughout). Pin the freeze to the morning of today.
    await db.query('UPDATE cf_sales_order_lines SET locked_at = ? WHERE order_id = ? AND locked_at IS NOT NULL', [`${T} 06:00:00`, o.id]);
    const [[line]] = await db.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [o.lineId]);
    await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, 2000, 'kg', 'entered')
                    ON DUPLICATE KEY UPDATE value_number = 2000, uom = 'kg'`, [COMPANY, weightSpec.id, line.item_id]);
    const tree = await B.explode(db, COMPANY, line.item_id, { rootQuantity: qty });
    const parts = [];
    const walk = (n) => { const kids = n.children.filter((x) => x.kind === 'temporary'); if (n.kind === 'temporary' && !kids.length) parts.push(n); kids.forEach(walk); };
    walk(tree.root);
    for (const p of parts) await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, saId, p.id, /Cleat/.test(p.name) ? 0.5 : 2]);
    await db.query('INSERT INTO cf_order_spec_defaults (company_id, order_id, order_line_id, specification_id, value_number) VALUES (?, ?, NULL, ?, 3)', [COMPANY, o.id, coatsId]);
    return { ...o, itemId: Number(line.item_id) };
  };
  const charges = {
    charges: [
      { key: 'fab', label: 'Fabrication', operationId: fab.id, basis: { type: 'weight', weight: 'drawing' }, rate: 45000, billing: 'pro_rata' },
      { key: 'pnt', label: 'Painting', operationId: paint.id, basis: { type: 'formula', expression: `${SA} * ${COATS}`, unit: 'm2' }, rate: 120, billing: 'on_completion' },
    ],
    material: { rate: 70000, weight: 'drawing' },
    lumpSums: [{ key: 'tr', label: 'Transport', amount: 50000 }],
  };
  const FIXED = BILL.addDays(T, 10);
  const milestonesA = [
    { key: 'm1', label: 'Advance', kind: 'percent', value: 10, trigger: { type: 'order_accepted' }, creditDays: 0 },
    { key: 'm2', label: 'Material in place', kind: 'percent', value: 10, trigger: { type: 'material_in_place' }, proRata: true, creditDays: 15 },
    { key: 'm3', label: 'Fabrication progress', kind: 'percent', value: 20, trigger: { type: 'operation_completed', operationId: fab.id }, proRata: true, creditDays: 30 },
    { key: 'm4', label: 'On dispatch', kind: 'percent', value: 30, trigger: { type: 'dispatched', mode: 'each' }, creditDays: 30 },
    { key: 'm5', label: 'After inspection', kind: 'percent', value: 10, trigger: { type: 'post_stage', stageKey: 's1' }, creditDays: 30 },
    { key: 'm6', label: '30 days after dispatch', kind: 'percent', value: 5, trigger: { type: 'days_after', days: 30, after: { type: 'fully_dispatched' } }, creditDays: 0 },
    { key: 'm7', label: 'Fixed date', kind: 'percent', value: 5, trigger: { type: 'fixed_date', date: FIXED }, creditDays: 0 },
    { key: 'm8', label: 'Retention', kind: 'percent', value: 10, trigger: { type: 'retention', months: 12, milestoneKey: 'm4' }, creditDays: 0 },
  ];
  const stages = [{ key: 's1', name: 'Inspection by RITES' }, { key: 's2', name: 'Erection at site' }];

  /** Raise the MR (shared, held), send the terms, approve them → confirmed. */
  const accept = async (o, milestones) => {
    const raised = await RQ.raiseRequisitions(db, c, o.id, { earmark: true });
    const saved = await ACC.saveAcceptance(db, c, o.id, { ...charges, milestones, stages });
    await AP.decide(db, md, saved.pending.approvalId, { decision: 'approve' }, asMd);
    const a = await ACC.getAcceptance(db, COMPANY, o.id);
    return { mr: raised.requisitions[0], acceptance: a, value: a.approved.estimate.value };
  };
  const board = (today = T, observe = true) => BILL.billingBoard(db, c, { search: tag }, { today, observe });

  /* ════════════════════ 1. an accepted order and its cards ════════════════════ */
  section('1. An accepted order — its milestones become cards');
  const A = await makeOrder('A', 2);
  const accA = await accept(A, milestonesA);
  const V = accA.value;
  const est = accA.acceptance.approved.estimate;
  ok('the order is confirmed by the approval', accA.acceptance.order.status === 'confirmed');
  ok('the order value is the charges (4 t × 45,000 + painting) + material (4 t × 70,000) + transport', near(V, 180000 + est.charges[1].amount + 280000 + 50000), j(est.charges));
  const M = (k) => BILL.milestoneAmount(milestonesA.find((m) => m.key === k), V);
  let b = await board();
  table('Step 1 — accepted: the advance is due, everything else is upcoming', b);
  const adv = find(b, A.id, 'm1');
  ok('the advance (order accepted) is DUE today, 10 % of the value', adv.length === 1 && adv[0].status === 'due' && adv[0].dueOn === T && near(adv[0].amount, V * 0.1), j(adv));
  ok('material, fabrication, dispatch, inspection, days-after, retention: UPCOMING for the whole amount', ['m2', 'm3', 'm4', 'm5', 'm6', 'm8'].every((k) => find(b, A.id, k).length === 1 && find(b, A.id, k)[0].status === 'upcoming' && find(b, A.id, k)[0].partKey === 'rest' && near(find(b, A.id, k)[0].amount, M(k))), j(cardsOf(b, A.id).map((x) => [x.milestone.key, x.partKey, x.status])));
  const fx = find(b, A.id, 'm7')[0];
  ok('the fixed date is upcoming, dated', fx.status === 'upcoming' && fx.dueOn === FIXED && near(fx.amount, M('m7')));
  ok('the cards say when: "When the material is in place", "On each dispatch", "12 months after …"', /material is in place/.test(find(b, A.id, 'm2')[0].milestone.trigger) && find(b, A.id, 'm4')[0].milestone.trigger === 'On each dispatch' && /12 months after "On dispatch"/.test(find(b, A.id, 'm8')[0].milestone.trigger));
  ok('the board counts what is due', b.counts.due === 1 && near(b.counts.dueAmount, V * 0.1), j(b.counts));
  ok('the lanes are Upcoming, Due to bill, Billed, Paid', b.lanes.map((l) => l.key).join(',') === 'upcoming,due,billed,paid');
  ok('the nav badge counts the due card', (await BILL.billingDueCount(db, COMPANY)) >= 1);
  const noDraft = await refusal(() => INV.createInvoice(db, c, A.id, {}));
  ok('a dispatch-style invoice is refused: the order is billed by its milestones', noDraft?.code === 'BILLED_BY_MILESTONES', noDraft?.message);

  /* ════════════════════ 2. material in place, in two goes ════════════════════ */
  section('2. Material locked for the MR — pro-rata, by week');
  for (const it of [G.A, G.B, G.C]) await G.receive(it, 50);
  let screen = await PRS.mrScreen(db, COMPANY, accA.mr.id);
  const lineOf = (itemId) => screen.lines.find((l) => Number(l.item.id) === Number(itemId));
  await PRS.saveMr(db, c, accA.mr.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: Number(l.item.id) === Number(G.A) ? l.required : 0 })) });
  b = await board();
  let [ev] = await db.query("SELECT id, quantity FROM cf_order_events WHERE order_id = ? AND event_type = 'material_progress' ORDER BY id", [A.id]);
  ok('the board saw 1 of 3 materials locked and recorded it (an event)', ev.length === 1 && near(ev[0].quantity, 1 / 3, 1e-5), j(ev));
  // That was last week. (The share is stored to 6 decimals, so a third is billed to within a few paise.)
  await db.query('UPDATE cf_order_events SET event_date = ? WHERE id = ?', [LAST_WEEK, ev[0].id]);
  screen = await PRS.mrScreen(db, COMPANY, accA.mr.id);
  await PRS.saveMr(db, c, accA.mr.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: l.required })) });
  b = await board();
  [ev] = await db.query("SELECT id, quantity, event_date FROM cf_order_events WHERE order_id = ? AND event_type = 'material_progress' ORDER BY id", [A.id]);
  ok('…then all three: a second event, share 1', ev.length === 2 && near(ev[1].quantity, 1, 1e-6));
  b = await board(T, true);
  ok('a second read records nothing new', (await db.query("SELECT COUNT(*) AS n FROM cf_order_events WHERE order_id = ? AND event_type = 'material_progress'", [A.id]))[0][0].n === 2);
  const wLast = `w${BILL.weekOf(LAST_WEEK)}`; const wNow = `w${MON}`;
  let m2 = find(b, A.id, 'm2');
  ok('last week\'s third is a DUE card (due on its Sunday)', m2.some((x) => x.partKey === wLast && x.status === 'due' && x.dueOn === BILL.addDays(BILL.weekOf(LAST_WEEK), 6) && near(x.amount, r2(M('m2') / 3), 0.05)), j(m2));
  const sundayNow = BILL.addDays(MON, 6);
  ok(`this week's two thirds: ${sundayNow <= T ? 'due (today is the Sunday)' : 'upcoming until Sunday'}`, m2.some((x) => x.partKey === wNow && x.status === (sundayNow <= T ? 'due' : 'upcoming') && near(x.amount, M('m2') - r2(M('m2') / 3), 0.05)), j(m2));
  ok('the parts add up to the milestone exactly', near(m2.reduce((t, x) => t + x.amount, 0), M('m2'), 0.001) && !m2.some((x) => x.partKey === 'rest'));
  table('Step 2 — material locked: one third last week, the rest this week', b);

  /* ════════════════════ 3. fabrication over two weeks ════════════════════ */
  section('3. Fabrication completed over two weeks — grouped weekly');
  const relA = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 2)', [COMPANY, A.id, A.lineId, A.itemId]);
  const piece = async (n) => ins('INSERT INTO cf_production_items (company_id, release_id, item_id, piece_no, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)', [COMPANY, relA, A.itemId, n, `${tag}-P${n}`, G.flow.id, n]);
  const p1 = await piece(1); const p2 = await piece(2);
  const step = (pid, opId, seq, state, started, finished) => ins(
    'INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, quantity, state, qty_good, started_at, finished_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
    [COMPANY, pid, opId, seq, state, state === 'done' ? 1 : 0, started, finished]);
  await step(p1, fab.id, 10, 'done', `${BILL.addDays(LAST_WEEK, -1)} 09:00:00`, `${LAST_WEEK} 17:00:00`);
  const s2 = await step(p2, fab.id, 10, 'in_progress', `${LAST_WEEK} 10:00:00`, null);
  await step(p1, paint.id, 20, 'pending', null, null);
  await step(p2, paint.id, 20, 'pending', null, null);
  b = await board();
  let m3 = find(b, A.id, 'm3');
  ok('girder 1 done last week: half the milestone, due', m3.some((x) => x.partKey === wLast && x.status === 'due' && near(x.amount, M('m3') / 2) && /2 t through Fabrication/.test(x.note)), j(m3));
  ok('the other half is still to come', m3.some((x) => x.partKey === 'rest' && x.status === 'upcoming' && near(x.amount, M('m3') / 2)));
  await db.query("UPDATE cf_production_steps SET state = 'done', qty_good = 1, finished_at = ? WHERE id = ?", [`${T} 12:00:00`, s2]);
  b = await board();
  m3 = find(b, A.id, 'm3');
  ok('girder 2 done this week: the second half is this week\'s card', m3.length === 2 && m3.some((x) => x.partKey === wNow && near(x.amount, M('m3') / 2)), j(m3));
  const bMon = await board(NEXT_MONDAY, false);
  ok('on Monday both weeks are due', find(bMon, A.id, 'm3').every((x) => x.status === 'due'));
  table('Step 3 — fabrication: girder 1 last week, girder 2 this week', b);

  /* ════════════════════ 4. dispatch per lot ════════════════════ */
  section('4. Dispatch per lot — a card per dispatch');
  const ship = async (date) => {
    await postMovement(db, c, { movementType: 'receipt', toAreaId: G.dispatch, lines: [{ itemId: A.itemId, quantity: 1 }], movementDate: date }, { fromProduction: true });
    const mv = await postMovement(db, c, { movementType: 'issue', orderId: A.id, orderLineId: A.lineId, fromAreaId: G.dispatch, lines: [{ itemId: A.itemId, quantity: 1 }], movementDate: date }, { fromProduction: true });
    await db.query('UPDATE cf_sales_order_lines SET delivered_qty = delivered_qty + 1 WHERE id = ?', [A.lineId]);
    return mv;
  };
  const mv1 = await ship(BILL.addDays(T, -3));
  b = await board();
  let m4 = find(b, A.id, 'm4');
  ok('dispatch 1 (one girder of two): half of the milestone, due', m4.some((x) => x.partKey === `mv${mv1.id}` && x.status === 'due' && near(x.amount, M('m4') / 2) && /2 t/.test(x.note)), j(m4));
  ok('"30 days after dispatch" still has no date (not everything is dispatched)', find(b, A.id, 'm6')[0].dueOn === null);
  const mv2 = await ship(T);
  b = await board();
  m4 = find(b, A.id, 'm4');
  ok('dispatch 2: the other half — two cards, one per dispatch', m4.length === 2 && m4.every((x) => x.status === 'due') && m4.some((x) => x.partKey === `mv${mv2.id}`), j(m4.map((x) => x.partKey)));
  const m6 = find(b, A.id, 'm6')[0];
  ok('fully dispatched: "30 days after" dated today + 30, upcoming', m6.status === 'upcoming' && m6.dueOn === BILL.addDays(T, 30), j(m6));
  const m8 = find(b, A.id, 'm8')[0];
  ok('retention: 12 months after the dispatch milestone was complete', m8.status === 'upcoming' && m8.dueOn === BILL.addMonths(T, 12), j(m8));
  ok('on day 30 the days-after card is due', find(await board(BILL.addDays(T, 30), false), A.id, 'm6')[0].status === 'due');
  table('Step 4 — dispatched in two lots', b);

  /* ════════════════════ 5. post-production stage; fixed date ════════════════════ */
  section('5. The inspection stage ticked; a fixed date');
  const st = (await ACC.postStagesOf(db, COMPANY, [A.id])).get(A.id);
  const tick1 = await BOARD.markStageDone(db, c, st[0].id, { date: T, note: 'IC 4411' });
  ok('ticking a stage does not close an order that is not paid', tick1.orderClosed === false);
  b = await board();
  ok('the inspection milestone is due from today', find(b, A.id, 'm5')[0].status === 'due' && find(b, A.id, 'm5')[0].dueOn === T);
  ok('the fixed date is due on the day', find(await board(FIXED, false), A.id, 'm7')[0].status === 'due' && find(b, A.id, 'm7')[0].status === 'upcoming');
  table('Step 5 — inspection done', b);

  /* ════════════════════ 6. raise a GST invoice ════════════════════ */
  section('6. Raise invoice — two due cards on one GST tax invoice (intra-state)');
  const advCard = find(b, A.id, 'm1')[0];
  const matCard = find(b, A.id, 'm2', wLast)[0];
  const dry = await BILL.raiseInvoice(db, c, { orderId: A.id, cards: [advCard.id, matCard.id], dryRun: true });
  ok('the preview: no problems, two lines, HSN 7308 at 18 %', dry.problems.length === 0 && dry.lines.length === 2 && dry.lines.every((l) => l.hsnCode === '7308' && l.gstRate === 18), j(dry.problems));
  const taxable = r2(advCard.amount + matCard.amount);
  const half = (x) => r2((x * 18) / 200);
  ok('intra-state: CGST = SGST = 9 % of each line; no IGST', dry.isIgst === false && near(dry.totals.cgst, half(advCard.amount) + half(matCard.amount)) && dry.totals.cgst === dry.totals.sgst && dry.totals.igst === 0, j(dry.totals));
  ok('the total is rounded to the rupee', dry.totals.grandTotal === Math.round(taxable + dry.totals.cgst + dry.totals.sgst) && near(dry.totals.taxable, taxable));
  ok('credit days: the smaller of the two milestones (0); due date = the invoice date', dry.creditDays === 0 && dry.dueDate === T);
  const upcomingRaise = await refusal(() => BILL.raiseInvoice(db, c, { orderId: A.id, cards: [find(b, A.id, 'm8')[0].id] }));
  ok('an upcoming card cannot be invoiced', upcomingRaise?.code === 'CANNOT_RAISE' && upcomingRaise.problems.some((p) => /not due yet/.test(p)), j(upcomingRaise?.problems));
  const inv1 = await BILL.raiseInvoice(db, c, { orderId: A.id, cards: [advCard.id, matCard.id] });
  ok(`numbered from the year's GST series: ${inv1.invoiceNo}`, inv1.invoiceNo === `INV/${TAX.financialYear(T).slice(2, 4)}-${TAX.financialYear(T).slice(5, 7)}/0001` && inv1.status === 'issued' && inv1.kind === 'billing', j([inv1.invoiceNo, inv1.status]));
  ok('the invoice reads its frozen milestone lines', inv1.lines.length === 2 && inv1.lines[0].milestone?.key === 'm1' && near(inv1.totals.taxable, taxable) && inv1.dueDate === T);
  const twice = await refusal(() => BILL.raiseInvoice(db, c, { orderId: A.id, cards: [advCard.id] }));
  ok('a billed card cannot be billed again', twice?.code === 'CANNOT_RAISE' && twice.problems.some((p) => /already on invoice/.test(p)));
  const pdf = await BILL.invoicePdf(db, COMPANY, inv1.id);
  ok('the invoice as a PDF', pdf.buffer.subarray(0, 4).toString() === '%PDF' && /\.pdf$/.test(pdf.filename));
  b = await board();
  ok('both cards are BILLED now, showing the invoice', find(b, A.id, 'm1')[0].status === 'billed' && find(b, A.id, 'm2', wLast)[0].invoice?.invoiceNo === inv1.invoiceNo);
  const bNext = await board(BILL.addDays(T, 1), false);
  ok('the day after the due date, unpaid → overdue (red)', find(bNext, A.id, 'm1')[0].overdue === true && find(bNext, A.id, 'm1')[0].daysOverdue === 1 && bNext.counts.overdue >= 2);
  table('Step 6 — invoice raised for the advance and last week\'s material', b);

  /* ════════════════════ 7. receipts ════════════════════ */
  section('7. Receipts — a part payment, then the rest');
  const badRc = await refusal(() => RC.recordReceipt(db, c, { invoiceId: inv1.id, amount: 0 }));
  ok('a receipt needs an amount', badRc?.status === 422 && badRc.problems.some((p) => /amount/.test(p)));
  const futureRc = await refusal(() => RC.recordReceipt(db, c, { invoiceId: inv1.id, amount: 10, receiptDate: '2099-01-01' }));
  ok('a receipt cannot be dated in the future', futureRc?.problems?.some((p) => /future/.test(p)));
  const part = r2(inv1.totals.grandTotal / 2);
  const rc1 = await RC.recordReceipt(db, c, { invoiceId: inv1.id, amount: part, mode: 'bank', reference: 'UTR123' });
  ok('part payment: allocated to the invoice, half still owed', near(rc1.allocated, part) && near(rc1.order.outstanding, inv1.totals.grandTotal - part) && rc1.receipt.code?.startsWith('RC-'), j([rc1.allocated, rc1.order.outstanding]));
  b = await board();
  ok('the cards stay BILLED with the outstanding shown', find(b, A.id, 'm1')[0].status === 'billed' && near(find(b, A.id, 'm1')[0].invoice.outstanding, inv1.totals.grandTotal - part));
  const rc2 = await RC.recordReceipt(db, c, { orderId: A.id, amount: r2(inv1.totals.grandTotal - part) + 1000, mode: 'cheque', reference: 'CHQ 556' });
  ok('the rest (+ ₹1,000): the invoice is paid, ₹1,000 kept on account', near(rc2.onAccount, 1000) && rc2.order.outstanding === 0 && near(rc2.order.onAccount, 1000), j([rc2.onAccount, rc2.order.onAccount]));
  b = await board();
  ok('…and its cards are PAID', find(b, A.id, 'm1')[0].status === 'paid' && find(b, A.id, 'm2', wLast)[0].status === 'paid');
  const dispCard = find(b, A.id, 'm4', `mv${mv1.id}`)[0];
  const inv2 = await BILL.raiseInvoice(db, c, { orderId: A.id, cards: [dispCard.id] });
  ok('the next invoice: 30 credit days → due in 30 days; the ₹1,000 on account goes onto it', inv2.creditDays === 30 && inv2.dueDate === BILL.addDays(T, 30) && near(inv2.received, 1000), j([inv2.creditDays, inv2.dueDate, inv2.received]));
  ok('not overdue before day 31, overdue after', find(await board(BILL.addDays(T, 30), false), A.id, 'm4', `mv${mv1.id}`)[0].overdue === false && find(await board(BILL.addDays(T, 31), false), A.id, 'm4', `mv${mv1.id}`)[0].overdue === true);
  let pay = await RC.orderPayments(db, COMPANY, A.id);
  ok('per order: invoiced, received, outstanding', pay.invoices.length === 2 && near(pay.outstanding, inv2.totals.grandTotal - 1000) && near(pay.received, inv1.totals.grandTotal + 1000), j([pay.invoiced, pay.received, pay.outstanding]));
  const cancelled = await INV.cancelInvoice(db, c, inv2.id, { reason: 'Wrong amount' });
  b = await board();
  ok('cancelling an invoice frees its card (due again) and puts its money back on account', cancelled.status === 'cancelled' && find(b, A.id, 'm4', `mv${mv1.id}`)[0].status === 'due' && near((await RC.orderPayments(db, COMPANY, A.id)).onAccount, 1000));
  table('Step 7 — paid in two goes; the dispatch invoice cancelled (its card due again)', b);

  /* ════════════════════ 8. an inter-state customer ════════════════════ */
  section('8. An inter-state customer — IGST');
  const Bo = await makeOrder('B', 1);
  await db.query('UPDATE cf_sales_orders SET customer_id = ? WHERE id = ?', [KA, Bo.id]);
  const accB = await accept(Bo, [
    { key: 'b1', label: 'Design frozen', kind: 'percent', value: 40, trigger: { type: 'design_frozen' }, creditDays: 7 },
    { key: 'b2', label: 'Production started', kind: 'percent', value: 30, trigger: { type: 'production_started' }, creditDays: 7 },
    { key: 'b3', label: 'Fully dispatched', kind: 'percent', value: 30, trigger: { type: 'fully_dispatched' }, creditDays: 7 },
  ]);
  b = await board();
  const b1 = find(b, Bo.id, 'b1')[0];
  ok('design frozen before acceptance: due at once', b1.status === 'due' && near(b1.amount, accB.value * 0.4));
  ok('production not started: upcoming', find(b, Bo.id, 'b2')[0].status === 'upcoming');
  const relB = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [COMPANY, Bo.id, Bo.lineId, Bo.itemId]);
  const pB = await ins('INSERT INTO cf_production_items (company_id, release_id, item_id, piece_no, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, 1, 1, ?, ?, 0, 1)', [COMPANY, relB, Bo.itemId, `${tag}-BP1`, G.flow.id]);
  await step(pB, fab.id, 10, 'in_progress', `${T} 08:00:00`, null);
  b = await board();
  ok('the first step started: "production started" due', find(b, Bo.id, 'b2')[0].status === 'due' && find(b, Bo.id, 'b2')[0].dueOn === T);
  const invB = await BILL.raiseInvoice(db, c, { orderId: Bo.id, cards: [b1.id] });
  ok('Karnataka customer: IGST 18 %, no CGST / SGST', invB.isIgst === true && near(invB.totals.igst, r2(b1.amount * 0.18)) && invB.totals.cgst === 0 && invB.totals.sgst === 0 && invB.placeOfSupply?.code === '29', j(invB.totals));
  ok('the next number in the series (the cancelled 0002 keeps its number)', /\/0003$/.test(invB.invoiceNo), invB.invoiceNo);
  table('Step 8 — an inter-state order (IGST)', b);
  const one = await H.measured(db, (q) => BILL.billingBoard(q, c, { orderId: A.id }, { today: T }));
  const two = await H.measured(db, (q) => BILL.billingBoard(q, c, { search: tag }, { today: T }));
  ok(`the board reads a fixed number of times, whatever the number of orders (${one.queries} for one, ${two.queries} for two)`, one.queries === two.queries && two.queries <= 20);

  /* ════════════════════ 9 + 10. issues "Used for"; the cost sheet ════════════════════ */
  section('9. Every issue says what it is used for');
  const wire = S.items.A;   // a consumable: welding wire, not on the girder MR
  await S.receive(wire, 100);
  await G.receive(G.A, 20);
  const noUse = await refusal(() => postMovement(db, c, { movementType: 'issue', fromAreaId: S.store, lines: [{ itemId: wire, quantity: 1 }] }));
  ok('an issue without "Used for" is refused', noUse?.status === 422 && noUse.problems.some((p) => /used for/i.test(p)), j(noUse?.problems));
  const both = await refusal(() => postMovement(db, c, { movementType: 'issue', usedFor: 'general', orderId: A.id, fromAreaId: S.store, lines: [{ itemId: wire, quantity: 1 }] }));
  ok('an issue cannot be for an order and General at once', both?.problems?.some((p) => /not both/.test(p)));
  const gen = await postMovement(db, c, { movementType: 'issue', usedFor: 'general', fromAreaId: S.store, lines: [{ itemId: wire, quantity: 5 }] });
  ok('General (overhead) is accepted and recorded', gen.usedFor === 'general' && gen.order === null);
  const cons = await postMovement(db, c, { movementType: 'issue', usedFor: 'order', orderId: A.id, orderLineId: A.lineId, fromAreaId: S.store, lines: [{ itemId: wire, quantity: 12 }] });
  ok('Used for the order (and its line)', cons.usedFor === 'order' && cons.order?.id === A.id && cons.orderLine?.id === A.lineId);
  await postMovement(db, c, { movementType: 'issue', orderId: A.id, fromAreaId: G.store, lines: [{ itemId: G.A, quantity: 4 }] });

  section('10. Order costing — the cost sheet');
  await SCRAP.setScrapRate(db, c, { ratePerKg: 30 });
  const scrapArea = await SCRAP.scrapArea(db, c);
  const scrapItem = await SCRAP.scrapItem(db, c);
  await writeTransform(db, c, { reference: `${tag}-SCRAP`, notes: 'Plate skeleton', orderId: A.id, orderLineId: A.lineId, legs: [{ areaId: scrapArea.id, itemId: scrapItem, batchId: null, delta: 50, unitCost: 30, value: 1500 }] });
  let sheet = await COST.costSheet(db, COMPANY, A.id);
  const pnt = est.charges.find((x) => x.key === 'pnt');
  ok('material: the MR item issued at cost (4 kg × ₹10)', near(sheet.material, 40), j(sheet.items));
  ok('consumables: the wire issued "Used for" the order (12 kg × ₹10); the General issue is not on it', near(sheet.consumables, 120));
  ok('credits: the scrap at the scrap rate (50 kg × ₹30)', near(sheet.credits, 1500) && near(sheet.creditsScrap, 1500));
  ok('contractor work: 0 until work orders are costed', sheet.contractor === 0);
  ok('charged so far: fabrication (all 4 t through) + material (all in place) + transport (all dispatched); painting not complete → 0',
    near(sheet.charged, 180000 + 280000 + 50000) && sheet.earned.rows.find((x) => x.key === 'pnt').amount === 0, j(sheet.earned.rows.map((x) => [x.key, x.amount])));
  ok('margin = charged − material − consumables − contractor + credits; and its %', near(sheet.margin, 510000 - 40 - 120 + 1500) && near(sheet.marginPct, r2(((510000 - 160 + 1500) / 510000) * 100)), j([sheet.margin, sheet.marginPct]));
  ok('the per-line nest figures come with it (the old order costs card)', Array.isArray(sheet.lines) && sheet.lines.length === 1);
  await db.query("UPDATE cf_production_steps SET state = 'done', qty_good = 1, finished_at = NOW() WHERE operation_id = ? AND production_item_id IN (?, ?)", [paint.id, p1, p2]);
  sheet = await COST.costSheet(db, COMPANY, A.id);
  ok('painting complete → its whole charge is earned (on completion)', near(sheet.earned.rows.find((x) => x.key === 'pnt').amount, pnt.amount) && near(sheet.charged, V));
  const list = await COST.costingList(db, COMPANY, { search: tag });
  const rowA = list.rows.find((r) => r.order.id === A.id);
  ok('the costing list: one row per order, the same numbers', list.rows.length === 2 && near(rowA.margin, sheet.margin) && near(rowA.consumables, 120) && list.generalThisMonth.value >= 50, j(list.generalThisMonth));
  runLog.push('## Step 10 — the cost sheet of order A', '', '| | ₹ |', '|---|---:|',
    `| Contract value | ${sheet.contract.toLocaleString('en-IN')} |`, `| Charged so far | ${sheet.charged.toLocaleString('en-IN')} |`, `| Material | ${sheet.material} |`, `| Consumables | ${sheet.consumables} |`,
    `| Contractor work | ${sheet.contractor} |`, `| Credits (scrap) | ${sheet.credits} |`, `| Margin | ${sheet.margin.toLocaleString('en-IN')} (${sheet.marginPct} %) |`, '');

  /* ════════════════════ 11. the close rule ════════════════════ */
  section('11. Closes only when the stages are done AND it is fully paid');
  const tick2 = await BOARD.markStageDone(db, c, st[1].id, { date: T, note: 'Erected' });
  let [[oA]] = await db.query('SELECT status FROM cf_sales_orders WHERE id = ?', [A.id]);
  ok('every stage done, everything shipped — but not paid: still open', tick2.orderClosed === false && oA.status === 'confirmed');
  const ob = await BOARD.orderBoard(db, COMPANY, { search: tag });
  const obA = ob.lanes.flatMap((l) => l.cards).find((x) => x.id === A.id);
  const handClose = await SO.setOrderStatus(db, c, A.id, 'closed', { fromRoute: true }).then(() => null, (e) => e);
  ok('the header Close is refused too while not fully paid (§74, 2026-10-19)', handClose?.code === 'NOT_FULLY_PAID', String(handClose?.message));
  ok('the orders board says what is owed and offers no Close yet', obA.lane === 'post_production' && obA.canClose === false && obA.facts.payment && !obA.facts.payment.fullyPaid, j(obA.facts.payment));
  // A year on: everything is due; one invoice of all of it, paid in full.
  const later = BILL.addMonths(T, 13);
  const bl = await board(later, false);
  const dueAll = find(bl, A.id, 'm1').length ? cardsOf(bl, A.id).filter((x) => x.status === 'due') : [];
  ok('a year on, every remaining card is due', cardsOf(bl, A.id).every((x) => x.status !== 'upcoming') && dueAll.length >= 5, j(cardsOf(bl, A.id).map((x) => [x.milestone.key, x.partKey, x.status])));
  const inv3 = await BILL.raiseInvoice(db, c, { orderId: A.id, cards: dueAll.map((x) => x.id) }, { today: later });
  pay = await RC.orderPayments(db, COMPANY, A.id);
  ok('one invoice for the rest; the ₹1,000 on account applied to it', near(inv3.received, 1000) && pay.billing.fullyBilled === true && pay.fullyPaid === false);
  const rc3 = await RC.recordReceipt(db, c, { invoiceId: inv3.id, amount: r2(inv3.totals.grandTotal - 1000), mode: 'bank' });
  [[oA]] = await db.query('SELECT status FROM cf_sales_orders WHERE id = ?', [A.id]);
  ok('fully paid → the order closes by itself', rc3.closed === true && oA.status === 'closed' && rc3.order.fullyPaid === true);
  const evs = await ACC.orderEvents(db, COMPANY, A.id);
  ok('"order_closed" is recorded', evs.some((e) => e.type === 'order_closed'));
  b = await board(later, false);
  ok('every card of order A is PAID', cardsOf(b, A.id).every((x) => x.status === 'paid'), j(cardsOf(b, A.id).filter((x) => x.status !== 'paid').map((x) => [x.milestone.key, x.partKey, x.status])));
  table('Step 11 — a year on: everything billed and paid; the order closed', b);

  // Pure helpers.
  ok('splitAmount keeps the paise', JSON.stringify(BILL.splitAmount(100, [1, 1, 1])) === '[33.34,33.33,33.33]');
  ok('weekOf is the Monday', BILL.weekOf('2026-10-18') === '2026-10-12' && BILL.weekOf('2026-10-12') === '2026-10-12');
  ok('addMonths keeps the month end', BILL.addMonths('2026-01-31', 1) === '2026-02-28');

  const [[l923b]] = await db.query('SELECT id, locked_at, (SELECT COUNT(*) FROM cf_production_releases r WHERE r.order_line_id = 923 AND r.deleted_at IS NULL) AS rel FROM cf_sales_order_lines WHERE id = 923');
  ok('line 923 untouched', JSON.stringify(l923 ?? null) === JSON.stringify(l923b ?? null));
} catch (e) {
  console.error(e);
  ok(`no crash: ${e.message}`, false, e.problems ? j(e.problems) : '');
} finally {
  await db.rollback();
  detachNodeCache(db);
  db.release();
}
const after = await H.counts();
const changed = after.filter((a) => Number(before.find((x) => x.name === a.name)?.n) !== Number(a.n));
ok('rolled back: every cf_ table is as it was', changed.length === 0, j(changed));
runLog.push(`Result: ${H.state.passed} passed, ${H.state.failed} failed. Everything was rolled back.`);
writeFileSync(path.join(BE, '..', 'ACCOUNTS_RUN.md'), `${runLog.join('\n')}\n`);
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.failed ? `\n  ${H.state.fails.join('\n  ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
