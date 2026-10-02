/**
 * procurement_test.mjs — CF_ERP purchase request -> RFQ -> quotes -> comparison ->
 * award -> POs (init.sql §39, TM/CF_ERP_PROCUREMENT_PLAN.md, procurementService).
 *
 *   cd multi_app_be && node scripts/cf_kepl/procurement_test.mjs
 *   CF_PROC_COMPANY=2 (default)
 *
 * Buy list -> request (skips what is already requested) -> submit -> approve
 * (own-request refusal, permission refusal) and the reject path (note required,
 * edit, resubmit, history) -> RFQ from approved lines only, one open RFQ per line
 * -> 3 suppliers, print + email -> quotes (one expired, one partial, upsert) ->
 * comparison (landed cost, cheapest / fastest / expired, recommendation) -> award
 * split -> create-pos (2 draft POs, prices, links, statuses) -> buy list in
 * request / in RFQ -> cancel an RFQ frees its lines -> round trips.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table. It owns its classification, items,
 * parties, order and release; every name carries the run's tag. It only READS two
 * existing users of the company (requester and approver ids for the FKs).
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createItem } from '../../apps/cf_erp/services/masterRecordService.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { buyList, getPurchaseOrder, createPurchaseOrder, addPurchaseLine, markOrdered } from '../../apps/cf_erp/services/purchaseService.js';
import * as P from '../../apps/cf_erp/services/procurementService.js';
import { translateDbError } from '../../apps/cf_erp/lib/errors.js';
import { todayText } from '../../apps/cf_erp/services/invoiceService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PROC_COMPANY ?? 2);
const tag = `PRQ${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
const says = (e, re) => !!e && [e.message, ...(e.problems ?? [])].some((p) => re.test(String(p)));
const near = (a, b, eps = 0.0001) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

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
  // Requester (buyer): may manage and approve, not admin. Approver: another person.
  const buyer = { companyId: COMPANY, userId: U1, canManage: true, canApprove: true, isAdmin: false };
  const approver = { companyId: COMPANY, userId: U2, canManage: true, canApprove: true, isAdmin: false };
  const clerk = { companyId: COMPANY, userId: U2, canManage: true, canApprove: false, isAdmin: false };
  const admin = { companyId: COMPANY, userId: U1, canManage: true, canApprove: true, isAdmin: true };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('purchase_order', 'purchase_request', 'rfq', 'sales_order')", [COMPANY]);

  // ---- fixture ---------------------------------------------------------------
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — procurement test`],
  );
  const variant = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');
  const party = (key, role, email) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, email, status) VALUES (?, ?, ?, 1, ?, 'active')`,
    [COMPANY, `${tag}-${key}`, `${tag} ${key}`, email]);
  const S1 = await party('S1', 'is_supplier', 's1@example.com');
  const S2 = await party('S2', 'is_supplier', 's2@example.com');
  const S3 = await party('S3', 'is_supplier', null);
  const customer = await party('CUS', 'is_customer', null);
  const item = async (key, extra = {}) => (await createItem(db, buyer, { classificationId: variant, code: `${tag}-${key}`, name: `${tag} ${key}`, status: 'active', ...extra })).id;
  const A = await item('A', { listPrice: 95 });
  const B = await item('B');
  const C = await item('C');
  const D = await item('D');
  const FG = await item('FG');
  const so = await createOrder(db, buyer, { orderType: 'customer', customerId: customer, code: `${tag}-SO`, committedDate: '2099-12-31' });
  const o = await addOrderLine(db, buyer, so.id, { recordId: FG, quantity: 1 });
  await setOrderStatus(db, buyer, so.id, 'confirmed');
  const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, ?)', [COMPANY, so.id, o.lines[0].id, FG, 1]);
  for (const [it, qty] of [[A, 4], [B, 100], [C, 7]]) await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [COMPANY, rel, it, qty]);
  const ours = async () => new Map((await buyList(db, COMPANY, { show: 'all' })).filter((r) => [A, B, C].includes(r.item.id)).map((r) => [r.item.id, r]));

  section('1. Buy list before anything is requested');
  let bl = await ours();
  ok('A, B, C short 4 / 100 / 7', bl.get(A)?.toBuy === 4 && bl.get(B)?.toBuy === 100 && bl.get(C)?.toBuy === 7, JSON.stringify([...bl.values()].map((r) => r.toBuy)));
  ok('every row carries inRequest 0, inRfq 0, toRequest = toBuy', [...bl.values()].every((r) => r.inRequest === 0 && r.inRfq === 0 && r.toRequest === r.toBuy && Array.isArray(r.purchaseRequests) && Array.isArray(r.rfqs)));

  section('2. Purchase request from the buy list');
  let e = await refusal(() => P.requestFromBuyList(db, buyer, {}));
  ok('no rows and not all → refused', says(e, /Choose rows of the buy list/), e?.message);
  let pr = await P.requestFromBuyList(db, buyer, { rows: [{ itemId: A }, { itemId: B, quantity: 250 }, { itemId: C, quantity: 7 }, { itemId: D }], neededBy: addDays(todayText(), 20) });
  ok('a draft request numbered PR-000123 (no coding rule)', pr.status === 'draft' && /^PR-\d{6}$/.test(pr.code), pr.code);
  ok('three lines: A 4, B 100 (trimmed), C 7', pr.lines.length === 3 && pr.lines.find((l) => l.item.id === A)?.quantity === 4
    && pr.lines.find((l) => l.item.id === B)?.quantity === 100 && pr.lines.find((l) => l.item.id === C)?.quantity === 7, JSON.stringify(pr.lines.map((l) => [l.item.code, l.quantity])));
  ok('skipped: B trimmed (250 asked, 100 taken), D not short', pr.skipped.some((s) => s.itemId === B && s.requested === 250 && s.taken === 100)
    && pr.skipped.some((s) => s.itemId === D && /not short/.test(s.reason)), JSON.stringify(pr.skipped));
  ok('A estimated at its list price (95, never bought)', pr.lines.find((l) => l.item.id === A)?.estUnitPrice === 95 && pr.lines.find((l) => l.item.id === A)?.estAmount === 380);
  ok('B unpriced: estUnitPrice null, counted in unpricedLines, estTotal = 380', pr.lines.find((l) => l.item.id === B)?.estUnitPrice === null && pr.unpricedLines === 2 && pr.estTotal === 380, JSON.stringify({ u: pr.unpricedLines, t: pr.estTotal }));
  ok('a line keeps its buy-list source (the order)', pr.lines[0].source?.from === 'buy_list' && pr.lines[0].source.orders.some((x) => x.id === so.id), JSON.stringify(pr.lines[0].source));
  ok('requestedBy = the buyer; history starts with created', pr.requestedBy?.id === U1 && pr.history[0]?.action === 'created');
  ok('allowed: edit + submit, no approve while draft', pr.allowed.edit && pr.allowed.submit && !pr.allowed.approve && !pr.allowed.makeRfq);
  bl = await ours();
  ok('buy list: toBuy unchanged, inRequest = the requested qty, toRequest 0', bl.get(A).toBuy === 4 && bl.get(A).inRequest === 4 && bl.get(A).toRequest === 0
    && bl.get(B).inRequest === 100 && bl.get(B).purchaseRequests.some((x) => x.id === pr.id), JSON.stringify(bl.get(A)));
  e = await refusal(() => P.requestFromBuyList(db, buyer, { rows: [{ itemId: A }, { itemId: B }] }));
  ok('raising again skips what is already in a request → NOTHING_TO_REQUEST', e?.code === 'NOTHING_TO_REQUEST' && e.skipped?.length === 2, e?.message);

  section('3. Editing, submitting, approving');
  pr = await P.updateRequest(db, buyer, pr.id, { notes: 'For the test order' });
  const lineB = pr.lines.find((l) => l.item.id === B);
  pr = await P.updateRequestLine(db, buyer, lineB.id, { estUnitPrice: 11 });
  ok('a line edit in draft (B est 11 → amount 1100)', pr.lines.find((l) => l.id === lineB.id).estAmount === 1100);
  pr = await P.submitRequest(db, buyer, pr.id);
  ok('submitted', pr.status === 'submitted' && pr.submittedAt != null);
  e = await refusal(() => P.updateRequest(db, buyer, pr.id, { notes: 'x' }));
  ok('a submitted request cannot be edited', e?.code === 'NOT_EDITABLE');
  const own = await P.getRequest(db, buyer, pr.id);
  ok('allowed.approve is false for the requester (not admin)', own.allowed.approve === false && own.allowed.reject === true);
  e = await refusal(() => P.approveRequest(db, buyer, pr.id));
  ok('the requester cannot approve their own request', e?.status === 403 && /somebody else/.test(e.message), e?.message);
  e = await refusal(() => P.approveRequest(db, clerk, pr.id));
  ok('without cf_erp_purchase_approve → 403', e?.status === 403 && /cf_erp_purchase_approve/.test(e.message));
  ok('an admin may approve their own (allowed flag)', (await P.getRequest(db, admin, pr.id)).allowed.approve === true);
  pr = await P.approveRequest(db, approver, pr.id, { note: 'ok' });
  ok('approved by the other person, with the note', pr.status === 'approved' && pr.decidedBy?.id === U2 && pr.decisionNote === 'ok');
  ok('allowed.makeRfq on the approved request', pr.allowed.makeRfq === true && pr.allowed.edit === false);

  section('4. The reject path');
  let r2 = await P.createRequest(db, buyer, { lines: [{ itemId: D, quantity: 3, estUnitPrice: 5 }] });
  e = await refusal(() => P.createRequest(db, buyer, { lines: [{ itemId: D, quantity: 0 }] }));
  ok('a zero quantity is refused in words', says(e, /quantity is a number above zero/), JSON.stringify(e?.problems));
  r2 = await P.submitRequest(db, buyer, r2.id);
  e = await refusal(() => P.rejectRequest(db, approver, r2.id, {}));
  ok('reject needs a note', e?.code === 'NOTE_REQUIRED');
  e = await refusal(() => P.rejectRequest(db, clerk, r2.id, { note: 'no' }));
  ok('reject without the permission → 403', e?.status === 403);
  r2 = await P.rejectRequest(db, approver, r2.id, { note: 'Use stock instead' });
  ok('rejected, note kept', r2.status === 'rejected' && r2.decisionNote === 'Use stock instead');
  const rej = r2.history.find((h) => h.action === 'rejected');
  ok('history entry: { at, action, status, by: { name }, note }', !!rej?.at && rej.status === 'rejected' && rej.by?.id === U2 && 'name' in rej.by && rej.note === 'Use stock instead');
  e = await refusal(() => P.createRfq(db, buyer, { requestId: r2.id }));
  ok('a rejected request cannot go for quotes', says(e, /only an approved request/), JSON.stringify(e?.problems));
  r2 = await P.addRequestLine(db, buyer, r2.id, { itemId: C, quantity: 1 });
  ok('a rejected request can be edited (line added)', r2.lines.length === 2);
  r2 = await P.submitRequest(db, buyer, r2.id);
  ok('resubmitted: decision cleared, history keeps created/submitted/rejected/submitted',
    r2.status === 'submitted' && r2.decidedBy === null && r2.history.map((h) => h.action).join(',') === 'created,submitted,rejected,submitted', r2.history.map((h) => h.action).join(','));
  e = await refusal(() => P.createRfq(db, buyer, { requestLineIds: [r2.lines[0].id] }));
  ok('a submitted (not approved) line cannot go into an RFQ', says(e, /only an approved request/));
  r2 = await P.cancelRequest(db, buyer, r2.id);
  ok('cancelled: lines cancelled', r2.status === 'cancelled' && r2.lines.every((l) => l.status === 'cancelled'));

  section('5. RFQ');
  let rfq = await P.createRfq(db, buyer, { requestId: pr.id, quotesDue: addDays(todayText(), 7), terms: 'Delivery to our works. Mill test certificates required.' });
  ok('an RFQ numbered RFQ-000123 with the 3 lines', /^RFQ-\d{6}$/.test(rfq.code) && rfq.status === 'draft' && rfq.lines.length === 3, rfq.code);
  ok('each line linked to its request line', rfq.lines.every((l) => l.requestLine?.requestId === pr.id));
  pr = await P.getRequest(db, buyer, pr.id);
  ok('request lines are in_rfq and name the RFQ', pr.lines.every((l) => l.status === 'in_rfq' && l.rfq?.id === rfq.id));
  ok('the request cannot be cancelled while lines are in an RFQ', pr.allowed.cancel === false && (await refusal(() => P.cancelRequest(db, buyer, pr.id)))?.code === 'IN_RFQ');
  e = await refusal(() => P.createRfq(db, buyer, { requestLineIds: [pr.lines[0].id] }));
  ok('a line is in one open RFQ at a time', says(e, /already in an RFQ/), JSON.stringify(e?.problems));
  bl = await ours();
  ok('buy list: inRfq = 4 / 100 / 7, inRequest 0, the RFQ named', bl.get(A).inRfq === 4 && bl.get(B).inRfq === 100 && bl.get(C).inRfq === 7
    && bl.get(A).inRequest === 0 && bl.get(A).rfqs.some((x) => x.id === rfq.id), JSON.stringify(bl.get(A)));
  for (const s of [S1, S2, S3]) rfq = await P.addRfqSupplier(db, buyer, rfq.id, { supplierId: s });
  ok('three suppliers invited; email defaults to the party email', rfq.suppliers.length === 3 && rfq.suppliers.every((s) => s.status === 'invited')
    && rfq.suppliers.find((s) => s.supplier.id === S1).contactEmail === 's1@example.com');
  e = translateDbError(await refusal(() => P.addRfqSupplier(db, buyer, rfq.id, { supplierId: S1 })));
  ok('the same supplier twice → "already on this RFQ"', e?.code === 'DUPLICATE' && /already on this RFQ/.test(e.message), e?.message);
  e = await refusal(() => P.addRfqSupplier(db, buyer, rfq.id, { supplierId: customer }));
  ok('a party that is not a supplier is refused', says(e, /not marked as a supplier/));
  const html = await P.rfqPrintHtml(db, buyer, rfq.id, S1);
  ok('print: A4 HTML with the RFQ number, supplier, every item, quotes-due date and terms',
    html.startsWith('<!doctype html>') && html.includes('size: A4') && html.includes(rfq.code) && html.includes(`${tag} S1`)
      && [A, B, C].every((x) => html.includes(`${tag}-${String.fromCharCode(64 + [A, B, C].indexOf(x) + 1)}`)) && html.includes('Mill test certificates'));
  ok('print: no external assets', !/(src|href)=["']https?:/i.test(html) && !/@import|url\(/i.test(html));
  const mail = await P.rfqEmail(db, buyer, rfq.id, S1);
  ok('email: to the supplier, subject with the RFQ number, body lists the lines', mail.to === 's1@example.com' && mail.subject.includes(rfq.code)
    && mail.body.includes(`${tag}-B — ${tag} B: 100`) && /GST rate/.test(mail.body), JSON.stringify(mail).slice(0, 200));
  ok('email to a supplier with no address: to is empty, not missing', (await P.rfqEmail(db, buyer, rfq.id, S3)).to === '');
  e = await refusal(() => P.rfqEmail(db, buyer, rfq.id, customer));
  ok('email for a party not on the RFQ → 404', e?.status === 404);
  rfq = await P.markRfqSent(db, buyer, rfq.id, { supplierId: S1 });
  ok('mark sent: the supplier is sent and the RFQ goes draft → sent', rfq.status === 'sent' && rfq.sentAt != null && rfq.suppliers.find((s) => s.supplier.id === S1).status === 'sent');

  section('6. Quotes');
  const L = Object.fromEntries(rfq.lines.map((l) => [l.item.id, l.id]));
  const future = addDays(todayText(), 30);
  const yesterday = addDays(todayText(), -1);
  e = await refusal(() => P.upsertQuote(db, buyer, rfq.id, { supplierId: S1, lines: [{ rfqLineId: L[A], unitPrice: -1 }] }));
  ok('a negative price is refused', says(e, /cannot be negative/));
  rfq = await P.upsertQuote(db, buyer, rfq.id, {
    supplierId: S1, quoteRef: 'S1-Q1', validUntil: future, freightAmount: 500, paymentTerms: '30 days',
    lines: [{ rfqLineId: L[A], unitPrice: 100, gstRate: 18, leadTimeDays: 10 }, { rfqLineId: L[B], unitPrice: 10, gstRate: 18, leadTimeDays: 10 }, { rfqLineId: L[C], unitPrice: 50, gstRate: 18, leadTimeDays: 10 }],
  });
  const q1 = rfq.quotes.find((q) => q.supplierId === S1);
  // Upsert: the same supplier again updates the same quote (freight 500 → 1000).
  rfq = await P.upsertQuote(db, buyer, rfq.id, { supplierId: S1, freightAmount: 1000, lines: [{ rfqLineId: L[A], unitPrice: 100, gstRate: 18, leadTimeDays: 10 }] });
  const q1b = rfq.quotes.find((q) => q.supplierId === S1);
  ok('upsert per supplier: one quote, same id, freight updated, other lines kept', rfq.quotes.length === 1 && q1b.id === q1.id && q1b.freightAmount === 1000
    && q1b.lines.length === 3 && q1b.lines.find((l) => l.rfqLineId === L[C]).unitPrice === 50 && q1b.lines.find((l) => l.rfqLineId === L[A]).id === q1.lines.find((l) => l.rfqLineId === L[A]).id);
  ok('the supplier is quoted; quote total 1750', rfq.suppliers.find((s) => s.supplier.id === S1).status === 'quoted' && q1b.total === 1750, String(q1b.total));
  // S2: cheaper on A and fast; B offered only 60 of 100 (partial); C not quoted.
  rfq = await P.upsertQuote(db, buyer, rfq.id, {
    supplierId: S2, quoteRef: 'S2-77', validUntil: future,
    lines: [{ rfqLineId: L[A], unitPrice: 90, gstRate: 18, leadTimeDays: 5 }, { rfqLineId: L[B], unitPrice: 12, gstRate: 18, leadTimeDays: 5, qtyOffered: 60 }, { rfqLineId: L[C], unitPrice: '' }],
  });
  // S3: cheapest everywhere, but the quote expired yesterday.
  rfq = await P.upsertQuote(db, buyer, rfq.id, {
    supplierId: S3, validUntil: yesterday,
    lines: [{ rfqLineId: L[A], unitPrice: 80, leadTimeDays: 2 }, { rfqLineId: L[B], unitPrice: 9, leadTimeDays: 2 }, { rfqLineId: L[C], unitPrice: 40, leadTimeDays: 2 }],
  });
  ok('three quotes; S3 flagged expired', rfq.quotes.length === 3 && rfq.quotes.find((q) => q.supplierId === S3).expired === true && rfq.quotes.find((q) => q.supplierId === S2).expired === false);
  const gq2 = await P.getQuote(db, buyer, rfq.quotes.find((q) => q.supplierId === S2).id);
  ok('GET /quotes/:id prefill: header + one row per RFQ line, unquoted C as nulls', gq2.quoteRef === 'S2-77' && gq2.supplier.id === S2 && gq2.lines.length === 3
    && gq2.lines.find((l) => l.rfqLineId === L[B]).qtyOffered === 60 && gq2.lines.find((l) => l.rfqLineId === L[C]).unitPrice === null, JSON.stringify(gq2.lines));
  ok('RFQ allowed flags: addSupplier, quote, award, createPos (none awarded yet)', rfq.allowed.addSupplier === true && rfq.allowed.quote === true && rfq.allowed.award === true && rfq.allowed.createPos === false);
  ok('RFQ lines carry request { id, code }', rfq.lines.every((l) => l.request?.id === pr.id && l.request.code === pr.code));
  e = await refusal(() => P.upsertQuote(db, buyer, rfq.id, { supplierId: customer, lines: [] }));
  ok('a quote from a party not on the RFQ → 404', e?.status === 404);

  section('7. Comparison');
  const { result: cmp, queries: cmpQ } = await measured(() => P.rfqComparison(db, buyer, rfq.id));
  const line = (it) => cmp.lines.find((l) => l.rfqLine.item.id === it);
  const cell = (it, s) => line(it).cells.find((x) => x.supplierId === s);
  ok('S1 A: freight 1000 shared by amount (400 of 1750) = 228.57; landed 157.1429',
    cell(A, S1).freightShare === 228.57 && near(cell(A, S1).landedUnit, 157.1429), JSON.stringify(cell(A, S1)));
  ok('S1 B: share 571.43, landed 15.7143; S1 C: share 200, landed 78.5714',
    cell(B, S1).freightShare === 571.43 && near(cell(B, S1).landedUnit, 15.7143) && cell(C, S1).freightShare === 200 && near(cell(C, S1).landedUnit, 78.5714));
  ok('S2 no freight: landed = unit price', cell(A, S2).landedUnit === 90 && cell(A, S2).freightShare === 0);
  ok('S2 B is partial (60 of 100), amount on 60', cell(B, S2).partial === true && cell(B, S2).amount === 720 && cell(B, S2).qtyOffered === 60);
  ok('S2 C not quoted: price, amount, landed null; not valid', cell(C, S2).unitPrice === null && cell(C, S2).amount === null && cell(C, S2).valid === false);
  ok('S3 expired: flagged, not valid, never cheapest or fastest', [A, B, C].every((it) => cell(it, S3).expired && !cell(it, S3).valid && !cell(it, S3).cheapest && !cell(it, S3).fastest));
  ok('A: S2 cheapest and fastest', cell(A, S2).cheapest && cell(A, S2).fastest && !cell(A, S1).cheapest);
  ok('B: S2 cheapest landed (12 < 15.71) even though partial', cell(B, S2).cheapest && !cell(B, S1).cheapest);
  ok('C: S1 the only valid → cheapest', cell(C, S1).cheapest);
  ok('the GST rate rides along on the cell', cell(A, S1).gstRate === 18);
  const rec = new Map(cmp.recommendation.perLine.map((p) => [p.rfqLineId, p]));
  ok('recommend A → S2 (cheapest valid full offer)', rec.get(L[A]).supplierId === S2);
  ok('recommend B → S1 (S2 offers only part; full offers first); never S3', rec.get(L[B]).supplierId === S1 && rec.get(L[B]).partial === false);
  ok('recommend C → S1; every recommendation carries its quote line', rec.get(L[C]).supplierId === S1 && [...rec.values()].every((p) => p.quoteLineId != null));
  const sup = (s) => cmp.suppliers.find((x) => x.id === s);
  ok('supplier totals: S1 1750 + 1000 freight = 2750 landed, 3 lines; S2 360 + 720 = 1080, 2 lines',
    sup(S1).total === 1750 && sup(S1).landedTotal === 2750 && sup(S1).linesQuoted === 3 && sup(S2).total === 1080 && sup(S2).linesQuoted === 2, JSON.stringify(cmp.suppliers));
  ok('S3 summary marked expired', sup(S3).expired === true);

  section('8. Award');
  const qlOf = (s, it) => cell(it, s).quoteLineId;
  e = await refusal(() => P.awardRfq(db, buyer, rfq.id, { awards: [{ rfqLineId: L[A], quoteLineId: qlOf(S1, B) }] }));
  ok('a quote line of another line is refused', says(e, /not for this line/), JSON.stringify(e?.problems));
  e = await refusal(() => P.awardRfq(db, buyer, rfq.id, { awards: [{ rfqLineId: L[C], quoteLineId: qlOf(S2, C) }] }));
  ok('an unquoted (blank price) line cannot be awarded', says(e, /did not quote a price/), JSON.stringify(e?.problems));
  e = await refusal(() => P.createPosFromRfq(db, buyer, rfq.id));
  ok('create-pos before any award → NOTHING_AWARDED', e?.code === 'NOTHING_AWARDED');
  rfq = await P.awardRfq(db, buyer, rfq.id, { awards: [{ rfqLineId: L[A], quoteLineId: qlOf(S2, A) }, { rfqLineId: L[B], quoteLineId: qlOf(S2, B) }, { rfqLineId: L[C], quoteLineId: qlOf(S1, C) }] });
  ok('award split: A, B → S2; C → S1', rfq.lines.find((l) => l.id === L[A]).award?.supplierId === S2 && rfq.lines.find((l) => l.id === L[B]).award?.supplierId === S2
    && rfq.lines.find((l) => l.id === L[C]).award?.supplierId === S1 && rfq.allowed.createPos === true);
  ok('comparison shows the awarded cells', (await P.rfqComparison(db, buyer, rfq.id)).lines.find((l) => l.rfqLine.id === L[C]).cells.find((x) => x.supplierId === S1).awarded === true);

  section('9. Create purchase orders');
  const { result: made, queries: posQ } = await measured(() => P.createPosFromRfq(db, buyer, rfq.id));
  ok('two draft POs, one per awarded supplier', made.purchaseOrders.length === 2 && made.purchaseOrders.every((p) => /^PO-\d{6}$/.test(p.code)), JSON.stringify(made.purchaseOrders.map((p) => p.code)));
  const po2 = await getPurchaseOrder(db, COMPANY, made.purchaseOrders.find((p) => p.supplier.id === S2).id);
  const po1 = await getPurchaseOrder(db, COMPANY, made.purchaseOrders.find((p) => p.supplier.id === S1).id);
  ok('S2 PO: draft, supplier S2, A 4 @ 90, B 60 @ 12 (the offered quantity)', po2.status === 'draft' && po2.supplier?.id === S2
    && po2.lines.find((l) => l.item.id === A)?.quantity === 4 && po2.lines.find((l) => l.item.id === A)?.unitPrice === 90
    && po2.lines.find((l) => l.item.id === B)?.quantity === 60 && po2.lines.find((l) => l.item.id === B)?.unitPrice === 12, JSON.stringify(po2.lines.map((l) => [l.item.code, l.quantity, l.unitPrice])));
  ok('S1 PO: C 7 @ 50; notes name the RFQ, quote, payment and freight', po1.lines.length === 1 && po1.lines[0].quantity === 7 && po1.lines[0].unitPrice === 50
    && po1.notes.includes(rfq.code) && po1.notes.includes('S1-Q1') && po1.notes.includes('30 days') && po1.notes.includes('1000'), po1.notes);
  ok('S2 PO expected date = today + 5 days (lead time)', po2.expectedDate === addDays(todayText(), 5), String(po2.expectedDate));
  const [links] = await db.query('SELECT item_id, quote_line_id, request_line_id FROM cf_purchase_order_lines WHERE purchase_order_id IN (?) AND deleted_at IS NULL', [[po1.id, po2.id]]);
  const reqLineOf = new Map(pr.lines.map((l) => [l.item.id, l.id]));
  ok('every PO line carries its quote line and request line', links.length === 3 && links.every((l) => l.quote_line_id === qlOf(l.item_id === C ? S1 : S2, l.item_id) && l.request_line_id === reqLineOf.get(l.item_id)));
  ok('the response lists the lines with links', made.purchaseOrders.every((p) => p.lines.every((l) => l.quoteLineId && l.requestLineId)));
  rfq = made.rfq;
  ok('RFQ → awarded; every line names its PO', rfq.status === 'awarded' && rfq.lines.every((l) => l.po?.id));
  ok('RFQ detail lists purchaseOrders [{ id, code, supplier }]', rfq.purchaseOrders.length === 2 && rfq.purchaseOrders.every((p) => p.id && p.code && p.supplier?.name));
  pr = await P.getRequest(db, buyer, pr.id);
  ok('request lines → ordered, each naming its PO; request → closed', pr.status === 'closed' && pr.lines.every((l) => l.status === 'ordered' && l.po?.id), JSON.stringify(pr.lines.map((l) => [l.status, l.po?.code])));
  ok('history ends with closed', pr.history.at(-1)?.action === 'closed');
  e = await refusal(() => P.createPosFromRfq(db, buyer, rfq.id));
  ok('create-pos again on an awarded RFQ is refused', e?.code === 'RFQ_NOT_OPEN');
  e = await refusal(() => P.awardRfq(db, buyer, rfq.id, { awards: [{ rfqLineId: L[A], quoteLineId: null }] }));
  ok('an awarded RFQ cannot be re-awarded', e?.code === 'RFQ_NOT_OPEN');

  section('10. Buy list after the POs');
  bl = await ours();
  ok('in request / in RFQ back to 0 (POs are on order now)', [A, B, C].every((it) => bl.get(it).inRequest === 0 && bl.get(it).inRfq === 0));
  ok('on order: A 4, B 60, C 7 → A and C covered', bl.get(A).onOrder === 4 && bl.get(A).toBuy === 0 && bl.get(C).toBuy === 0 && bl.get(B).onOrder === 60);
  ok('B short 40 again (the part S2 did not offer) and free to request', bl.get(B).toBuy === 40 && bl.get(B).toRequest === 40, JSON.stringify(bl.get(B)));

  section('11. Cancelling an RFQ frees its request lines; closing too');
  let r3 = await P.requestFromBuyList(db, buyer, { rows: [{ itemId: B }] });
  ok('the 40 left of B can be requested', r3.lines.length === 1 && r3.lines[0].quantity === 40);
  r3 = await P.approveRequest(db, approver, (await P.submitRequest(db, buyer, r3.id)).id);
  let rfq2 = await P.createRfq(db, buyer, { requestLineIds: [r3.lines[0].id], supplierIds: [S1, S2] });
  ok('a second RFQ with suppliers given up front', rfq2.suppliers.length === 2 && rfq2.lines.length === 1);
  rfq2 = await P.upsertQuote(db, buyer, rfq2.id, { supplierId: S1, lines: [{ rfqLineId: rfq2.lines[0].id, unitPrice: 11 }] });
  e = await refusal(() => P.removeRfqSupplier(db, buyer, rfq2.id, S1));
  ok('a supplier who has quoted cannot be removed', e?.code === 'HAS_QUOTE');
  rfq2 = await P.removeRfqSupplier(db, buyer, rfq2.id, S2);
  ok('a supplier who has not quoted can be removed', rfq2.suppliers.length === 1);
  rfq2 = await P.declineRfqSupplier(db, buyer, rfq2.id, S1);
  ok('decline marks the supplier', rfq2.suppliers[0].status === 'declined');
  rfq2 = await P.cancelRfq(db, buyer, rfq2.id);
  r3 = await P.getRequest(db, buyer, r3.id);
  ok('RFQ cancelled → its request line is open again (and can go into a new RFQ)', rfq2.status === 'cancelled' && r3.lines[0].status === 'open' && r3.lines[0].rfq === null && r3.allowed.makeRfq);
  bl = await ours();
  ok('buy list: B inRequest 40 again, inRfq 0', bl.get(B).inRequest === 40 && bl.get(B).inRfq === 0);
  let rfq3 = await P.createRfq(db, buyer, { requestId: r3.id });
  rfq3 = await P.closeRfq(db, buyer, rfq3.id);
  ok('closing an RFQ with nothing ordered frees the line too', rfq3.status === 'closed' && (await P.getRequest(db, buyer, r3.id)).lines[0].status === 'open');
  r3 = await P.cancelRequest(db, buyer, r3.id);
  ok('the request can then be cancelled', r3.status === 'cancelled');

  section('12. A PO still receives as before (draft → ordered)');
  const sent = await markOrdered(db, buyer, po2.id, {});
  ok('the S2 draft PO can be sent like any PO', sent.status === 'ordered');
  const manual = await createPurchaseOrder(db, buyer, {});
  const withLine = await addPurchaseLine(db, buyer, manual.id, { itemId: D, quantity: 1, unitPrice: 3 });
  ok('a PO line raised by hand has no quote / request link', withLine.lines.length === 1);

  section('13. Round trips (TiDB is ~49 ms away)');
  const lr = await measured(() => P.listRequests(db, COMPANY, {}));
  const gr = await measured(() => P.getRequest(db, buyer, pr.id));
  const lq = await measured(() => P.listRfqs(db, COMPANY, {}));
  const gq = await measured(() => P.getRfq(db, buyer, rfq.id));
  const bq = await measured(() => buyList(db, COMPANY, { show: 'all' }));
  console.log(`  list requests ${lr.queries} · request ${gr.queries} · list RFQs ${lq.queries} · RFQ ${gq.queries} · comparison ${cmpQ} · create-pos ${posQ} (2 POs, 3 lines) · buy list ${bq.queries}`);
  ok('list requests = 1 read; request detail = 3; list RFQs = 1; RFQ detail = 5', lr.queries === 1 && gr.queries === 3 && lq.queries === 1 && gq.queries === 5);
  ok('comparison = 6 reads', cmpQ === 6, String(cmpQ));
  ok('create-pos is set-based (≤ 35 statements for 2 POs incl. codes and the returned RFQ)', posQ <= 35, String(posQ));
  ok('the list rows are shaped', lr.result.rows.some((r) => r.id === pr.id && r.lines === 3 && r.status === 'closed' && r.requestedBy?.id === U1)
    && lq.result.rows.some((r) => r.id === rfq.id && r.lines === 3 && r.suppliers === 3 && r.quotes === 3 && r.linesOrdered === 3));
  ok('list filters: status=open leaves out closed requests', !(await P.listRequests(db, COMPANY, { status: 'open' })).rows.some((r) => r.id === pr.id));
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
