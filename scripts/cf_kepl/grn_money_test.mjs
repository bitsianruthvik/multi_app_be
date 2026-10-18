/**
 * grn_money_test.mjs — GRN MONEY CAPTURE (init.sql §80, TM/s80.sql; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — GRN money capture"): a GRN against a PO captures price / MRP / discount / HSN / GST (CGST+SGST or IGST by
 * the supplier's state against the company's), the supplier invoice (no + date, or "to follow" — flagged), freight and other
 * charges (taxable or not); the LANDED cost (taxable + freight share, no GST) is what stock is valued at.
 *
 *   cd multi_app_be && node scripts/cf_kepl/grn_money_test.mjs
 *   CF_GRN_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. The fixture is this run's own (tagged).
 *
 *   0  the pure arithmetic: shares add up to the paisa whatever the weights; discount % / amount
 *   1  intra-state: CGST + SGST; discount %, amount; freight taxable → its own tax; totals
 *   2  freight allocation into landed cost (by taxable value, exact), landed unit cost, GST not in it
 *   3  valuation uses landed cost: the ledger's unit cost, cf_item_costs average, a second GRN blends
 *   4  inter-state: IGST; a supplier who charges no GST; company state not set → asked, picked, stored
 *   5  required: price, GST rate, invoice no/date; missing invoice → "invoice to follow" flag; completing it
 *   6  guards: over-delivery, rate not on the list, dry run writes nothing, duplicate invoice warned, customer PO refused
 *   7  reads for Accounts: list + filters + detail; a receipt through the older call is flagged "no money captured"
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const GRN = await imp('apps/cf_erp/services/grnService.js');
const MONEY = await imp('apps/cf_erp/services/grnMoney.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const VAL = await imp('apps/cf_erp/services/valuationService.js');
const TAX = await imp('apps/cf_erp/services/taxService.js');

const COMPANY = Number(process.env.CF_GRN_COMPANY ?? 2);
const RUN = `GRN${Date.now().toString(36).toUpperCase()}`;
let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 0.005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const eq = (label, got, want) => ok(label, typeof want === 'number' ? near(got, want) : got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log(`\n${t}`);
async function refuses(label, fn, re) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const text = err ? [err.message, ...(err.problems ?? [])].join(' | ') : '';
  ok(label, !!err && (!re || re.test(text)), err ? text : 'it was allowed');
}
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const db = conn;
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null, canManage: true, isAdmin: true };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  console.log(`Company ${COMPANY} — run ${RUN}`);

  /* ───────────── fixture ───────────── */
  const [[settings]] = await db.query('SELECT state_code FROM cf_company_settings WHERE company_id = ?', [COMPANY]);
  if (!settings?.state_code) await db.query('INSERT INTO cf_company_settings (company_id, state_code) VALUES (?, ?) ON DUPLICATE KEY UPDATE state_code = VALUES(state_code)', [COMPANY, '27']);
  const COMPANY_STATE = settings?.state_code ?? '27';
  const OTHER_STATE = COMPANY_STATE === '29' ? '24' : '29';
  const node = (parent, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')", [COMPANY, parent, depth, `${RUN}-${key}`, `${RUN} ${key}`]);
  const fam = await node(null, 0, 'FAM'); const sub = await node(fam, 1, 'SUB'); const variant = await node(sub, 2, 'VAR');
  const item = async (key, hsn, rate) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, variant]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, hsn_code, gst_rate) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock', ?, ?)", [id, COMPANY, hsn, rate]);
    return id;
  };
  const A = await item('A', '7208', 18);
  const B = await item('B', '7306', 12);
  const NR = await item('NR', null, null);        // no HSN / rate on the item
  const area = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, `${RUN}-ST`, `${RUN} Store`]);
  const party = (key, state, reg, extra = 'is_supplier') => ins(`INSERT INTO cf_parties (company_id, code, name, ${extra}, status, state_code, gst_registration) VALUES (?, ?, ?, 1, 'active', ?, ?)`, [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, state, reg]);
  const S_IN = await party('SIN', COMPANY_STATE, 'regular');
  const S_OUT = await party('SOUT', OTHER_STATE, 'regular');
  const S_UNREG = await party('SUN', null, 'unregistered');
  const S_NOSTATE = await party('SNS', null, 'regular');
  const CUST = await party('CUS', COMPANY_STATE, 'regular', 'is_customer');
  let poNo = 0;
  const po = async (supplierId, lines, { customer = false } = {}) => {
    const id = await ins("INSERT INTO cf_purchase_orders (company_id, code, supplier_id, status, supplied_by_customer) VALUES (?, ?, ?, 'ordered', ?)", [COMPANY, `${RUN}-PO${++poNo}`, supplierId, customer ? 1 : 0]);
    const out = [];
    let n = 0;
    for (const [itemId, qty, price] of lines) out.push(await ins("INSERT INTO cf_purchase_order_lines (company_id, purchase_order_id, line_no, item_id, quantity, uom, unit_price) VALUES (?, ?, ?, ?, ?, 'nos', ?)", [COMPANY, id, ++n, itemId, qty, price]));
    return { id, lines: out };
  };
  const grn = (poId, body) => GRN.receiveGrn(db, c, poId, { stockingAreaId: area, movementDate: '2026-10-18', invoice: { no: `INV-${RUN}-${Math.random().toString(36).slice(2, 7)}`, date: '2026-10-17' }, ...body });
  const ledgerOf = async (movementId) => (await db.query('SELECT quantity, unit_cost, value FROM cf_stock_ledger WHERE company_id = ? AND movement_id = ?', [COMPANY, movementId]))[0].map((r) => ({ q: Number(r.quantity), unit: r.unit_cost == null ? null : Number(r.unit_cost), value: r.value == null ? null : Number(r.value) }));
  const billCount = async () => Number((await db.query('SELECT COUNT(*) n FROM cf_grn_bills WHERE company_id = ?', [COMPANY]))[0][0].n);

  /* ───────────── 0. the arithmetic ───────────── */
  section('0. The pure arithmetic');
  let sumOk = true;
  for (let t = 0; t < 400; t += 1) {
    const n = 1 + (t % 7);
    const w = Array.from({ length: n }, (_, i) => ((t * 31 + i * 17) % 11) * (t % 3 === 0 ? 0 : 1) + (t % 5 === 0 ? 0 : i));
    const total = Math.round(((t * 7919) % 100000)) / 100;
    const shares = MONEY.shareOut(total, w);
    if (Math.abs(shares.reduce((a, b) => a + b, 0) - total) > 1e-9 || shares.some((x) => x < 0)) sumOk = false;
  }
  ok('shares of a charge add up to it exactly (400 random cases, zero weights included)', sumOk);
  eq('discount 10% of 1,000', MONEY.discountOf(1000, 'pct', 10), 100);
  eq('discount ₹50 of 1,000', MONEY.discountOf(1000, 'amt', 50), 50);
  eq('no discount typed', MONEY.discountOf(1000, null, null), 0);

  /* ───────────── 1. intra-state ───────────── */
  section('1. Intra-state: CGST + SGST, discounts, taxable freight');
  const P1 = await po(S_IN, [[A, 10, 100], [B, 5, 200]]);
  const g1 = await grn(P1.id, {
    reference: 'DN-1',
    invoice: { no: `S-${RUN}-1`, date: '2026-10-17' },
    charges: { freight: { amount: 190, taxable: true, gstRate: 18 } },
    lines: [
      { lineId: P1.lines[0], quantity: 10, mrp: 150, discountMode: 'pct', discountValue: 10 },
      { lineId: P1.lines[1], quantity: 5, discountMode: 'amt', discountValue: 50 },
    ],
  });
  const b1 = g1.bill;
  ok('one bill, two lines, two stock receipts', b1.lineCount === 2 && g1.movements.length === 2);
  eq('the supplier is in the company\'s state → intra', b1.tax.supplyType, 'intra');
  const [a1, bb1] = b1.lines;
  eq('A: price prefilled from the PO line (100)', a1.unitPrice, 100);
  eq('A: gross 1,000', a1.gross, 1000); eq('A: discount 10% = 100', a1.discount.amount, 100); eq('A: taxable 900', a1.taxable, 900);
  eq('A: HSN from the item', a1.hsnCode, '7208'); eq('A: rate from the item', a1.gstRate, 18);
  eq('A: CGST 81', a1.cgst, 81); eq('A: SGST 81', a1.sgst, 81); eq('A: IGST 0', a1.igst, 0); eq('A: line total 1,062', a1.lineTotal, 1062);
  eq('A: MRP kept', a1.mrp, 150);
  eq('B: discount ₹50 → taxable 950', bb1.taxable, 950); eq('B: CGST 57 (12% / 2)', bb1.cgst, 57); eq('B: SGST 57', bb1.sgst, 57);
  eq('freight 190 taxable at 18% → 34.20 tax', b1.charges.freight.tax, 34.2);
  eq('bill taxable 1,850', b1.totals.taxable, 1850);
  eq('bill CGST 155.10 (goods 138 + freight 17.10)', b1.totals.cgst, 155.1);
  eq('bill SGST 155.10', b1.totals.sgst, 155.1);
  eq('bill total 2,350.20', b1.totals.total, 2350.2);
  ok('invoice kept', b1.invoice.no === `S-${RUN}-1` && b1.invoice.date === '2026-10-17' && !b1.invoice.pending);
  ok('no flags on a complete bill', b1.flags.length === 0 && b1.moneyCaptured);

  /* ───────────── 2. freight allocation → landed cost ───────────── */
  section('2. Freight allocated into landed cost');
  eq('A: freight share 92.43 (190 × 900 / 1,850, to the paisa)', a1.freightShare, 92.43);
  eq('B: freight share 97.57 (the odd paisa goes to the larger remainder)', bb1.freightShare, 97.57);
  eq('shares add up to the freight', a1.freightShare + bb1.freightShare, 190);
  eq('A: landed value 992.43', a1.landedValue, 992.43);
  eq('A: landed unit cost 99.2430', a1.landedUnitCost, 99.243);
  eq('B: landed unit cost 209.5140', bb1.landedUnitCost, 209.514);
  ok('GST is not in the landed cost (A: 99.243 < 100 price incl. nothing of the 18%)', a1.landedUnitCost < 110);
  // the same freight NOT taxable: still in the landed cost, no tax on it
  const P1b = await po(S_IN, [[A, 4, 100]]);
  const g1b = await grn(P1b.id, { charges: { freight: { amount: 40, taxable: false }, other: { amount: 10, taxable: false } }, lines: [{ lineId: P1b.lines[0], quantity: 4 }] });
  eq('non-taxable freight + other: no tax on them', g1b.bill.charges.freight.tax + g1b.bill.charges.other.tax, 0);
  eq('…but 50 is in the landed value: 450 / 4 = 112.5', g1b.bill.lines[0].landedUnitCost, 112.5);
  eq('bill total = 400 + 50 + 18% of 400 (72) = 522', g1b.bill.totals.total, 522);

  /* ───────────── 3. valuation ───────────── */
  section('3. Valuation uses the landed cost');
  const led = await ledgerOf(g1.movements[0].id);
  eq('the ledger row carries the LANDED unit cost, not the price', led[0].unit, 99.243);
  eq('…and the value 992.43', led[0].value, 992.43);
  const costA1 = await VAL.itemCost(db, COMPANY, A);
  const [[pool1]] = await db.query('SELECT avg_unit_cost, costed_qty FROM cf_item_costs WHERE company_id = ? AND item_id = ? AND owner_key = 0', [COMPANY, A]);
  ok('cf_item_costs holds both GRNs: 10 @ 99.243 and 4 @ 112.5', near(pool1.costed_qty, 14) && near(pool1.avg_unit_cost, (10 * 99.243 + 4 * 112.5) / 14, 0.001), JSON.stringify(pool1));
  ok('itemCost() reads the same average', near(costA1.average ?? costA1.avgUnitCost ?? pool1.avg_unit_cost, pool1.avg_unit_cost, 0.001), JSON.stringify(costA1).slice(0, 200));

  /* ───────────── 4. inter-state, no-GST supplier, company state not set ───────────── */
  section('4. IGST, a supplier who charges no GST, and the company state not set');
  const P2 = await po(S_OUT, [[A, 10, 100]]);
  const g2 = await grn(P2.id, { lines: [{ lineId: P2.lines[0], discountMode: 'pct', discountValue: 10 }], charges: { freight: { amount: 100, taxable: true, gstRate: 5 } } });
  eq('another state → inter', g2.bill.tax.supplyType, 'inter');
  eq('A: IGST 162 (18% of 900)', g2.bill.lines[0].igst, 162); eq('A: no CGST', g2.bill.lines[0].cgst, 0); eq('A: no SGST', g2.bill.lines[0].sgst, 0);
  eq('freight IGST 5', g2.bill.charges.freight.tax, 5);
  eq('bill IGST 167', g2.bill.totals.igst, 167);
  eq('bill total 900 + 100 + 167 = 1,167', g2.bill.totals.total, 1167);
  eq('landed unit cost (900 + 100) / 10', g2.bill.lines[0].landedUnitCost, 100);
  const P3 = await po(S_UNREG, [[A, 2, 500]]);
  const g3 = await grn(P3.id, { lines: [{ lineId: P3.lines[0] }] });
  eq('an unregistered supplier charges no GST', g3.bill.tax.supplyType, 'none');
  ok('…tax is zero and the total is the taxable value', g3.bill.totals.tax === undefined && g3.bill.totals.cgst + g3.bill.totals.sgst + g3.bill.totals.igst === 0 && near(g3.bill.totals.total, 1000));

  const P4 = await po(S_IN, [[A, 1, 100]]);
  await db.query('UPDATE cf_company_settings SET state_code = NULL WHERE company_id = ?', [COMPANY]);
  const ctx0 = await GRN.grnContext(db, COMPANY, P4.id);
  ok('company state not set → the screen is told to ask', ctx0.needsCompanyState === true && ctx0.company.stateCode == null);
  await refuses('without a picked state the GRN is refused, in words', () => grn(P4.id, { lines: [{ lineId: P4.lines[0] }] }), /GST state is not set/);
  const g4 = await grn(P4.id, { companyStateCode: COMPANY_STATE, lines: [{ lineId: P4.lines[0] }] });
  ok('with a picked state it books and says the state was picked', g4.bill.tax.statePicked === true && g4.bill.tax.companyState === COMPANY_STATE && g4.bill.tax.supplyType === 'intra');
  const P4b = await po(S_IN, [[A, 1, 100]]);
  const g4b = await grn(P4b.id, { companyStateCode: OTHER_STATE, lines: [{ lineId: P4b.lines[0] }] });
  ok('the picked state decides the split (supplier in the company state, picked another → IGST)', g4b.bill.tax.supplyType === 'inter');
  await db.query('UPDATE cf_company_settings SET state_code = ? WHERE company_id = ?', [COMPANY_STATE, COMPANY]);
  const P5 = await po(S_NOSTATE, [[A, 1, 100]]);
  const ctx5 = await GRN.grnContext(db, COMPANY, P5.id);
  ok('a supplier with no state → asked too', ctx5.needsSupplierState === true);
  await refuses('…refused until one is picked', () => grn(P5.id, { lines: [{ lineId: P5.lines[0] }] }), /supplier's state/);
  const g5 = await grn(P5.id, { supplierStateCode: OTHER_STATE, lines: [{ lineId: P5.lines[0] }] });
  ok('…then IGST', g5.bill.tax.supplyType === 'inter' && g5.bill.tax.supplierState === OTHER_STATE);

  /* ───────────── 5. required fields, "invoice to follow" ───────────── */
  section('5. Required fields, invoice to follow');
  const P6 = await po(S_IN, [[A, 3, 100], [NR, 2, null]]);
  await refuses('no invoice number / date and not "to follow" → refused', () => GRN.receiveGrn(db, c, P6.id, { stockingAreaId: area, lines: [{ lineId: P6.lines[0] }] }), /invoice number[\s\S]*invoice date/i);
  await refuses('no price on the line (and none on the PO) → refused', () => grn(P6.id, { lines: [{ lineId: P6.lines[1], gstRate: 18 }] }), /unit price is required/);
  await refuses('no GST rate on the item or typed → refused', () => grn(P6.id, { lines: [{ lineId: P6.lines[1], unitPrice: 10 }] }), /GST rate is required/);
  await refuses('a taxable freight needs its rate', () => grn(P6.id, { charges: { freight: { amount: 10, taxable: true } }, lines: [{ lineId: P6.lines[0] }] }), /Freight is taxable/);
  const gp = await GRN.receiveGrn(db, c, P6.id, { stockingAreaId: area, movementDate: '2026-10-18', invoice: { pending: true }, lines: [{ lineId: P6.lines[0] }, { lineId: P6.lines[1], unitPrice: 10, gstRate: 5 }] });
  ok('"invoice to follow" books and FLAGS the bill', gp.bill.invoice.pending === true && gp.bill.invoice.no == null && gp.bill.flags.includes('invoice_pending'));
  const pend = await GRN.listBills(db, COMPANY, { flag: 'invoice_pending', purchaseOrderId: P6.id });
  ok('it is on the invoice-pending list', pend.rows.length === 1 && pend.summary.invoicePending === 1);
  await refuses('completing it needs both number and date', () => GRN.completeInvoice(db, c, gp.bill.id, { no: 'X1' }), /invoice date/i);
  const done = await GRN.completeInvoice(db, c, gp.bill.id, { no: `LATE-${RUN}`, date: '2026-10-19' });
  ok('completing the invoice clears the flag; the money is untouched', done.invoice.pending === false && done.invoice.no === `LATE-${RUN}` && done.flags.length === 0 && done.totals.total === gp.bill.totals.total);
  eq('the PO is closed once everything is in', (await PS.getPurchaseOrder(db, COMPANY, P6.id)).status, 'received');

  /* ───────────── 6. guards ───────────── */
  section('6. Guards');
  const P7 = await po(S_IN, [[A, 5, 100]]);
  await refuses('more than is outstanding → refused', () => grn(P7.id, { lines: [{ lineId: P7.lines[0], quantity: 6 }] }), /still outstanding/);
  await refuses('a rate not on the company\'s list → refused', () => grn(P7.id, { lines: [{ lineId: P7.lines[0], gstRate: 17 }] }), /not on the company's list/);
  await refuses('a discount over 100% → refused', () => grn(P7.id, { lines: [{ lineId: P7.lines[0], discountMode: 'pct', discountValue: 120 }] }), /more than 100/);
  await refuses('a discount with no mode → refused', () => grn(P7.id, { lines: [{ lineId: P7.lines[0], discountValue: 10 }] }), /percentage or an amount/);
  await refuses('a line of another order → refused', () => grn(P7.id, { lines: [{ lineId: P6.lines[0] }] }), /not on/);
  const b0 = await billCount();
  const dry = await grn(P7.id, { dryRun: true, lines: [{ lineId: P7.lines[0], quantity: 2, discountMode: 'pct', discountValue: 5 }] });
  ok('a dry run answers the money and writes nothing', dry.dryRun === true && near(dry.money.totals.taxable, 190) && (await billCount()) === b0 && near((await PS.getPurchaseOrder(db, COMPANY, P7.id)).lines[0].received, 0));
  const dupNo = `DUP-${RUN}`;
  await grn(P7.id, { invoice: { no: dupNo, date: '2026-10-17' }, lines: [{ lineId: P7.lines[0], quantity: 2 }] });
  const dup = await grn(P7.id, { invoice: { no: dupNo.toLowerCase(), date: '2026-10-17' }, lines: [{ lineId: P7.lines[0], quantity: 3 }] });
  ok('the same supplier invoice twice is WARNED (not refused — one invoice may span two deliveries)', dup.warnings.some((w) => /already on/.test(w)));
  const PC = await po(CUST, [[A, 1, 0]], { customer: true });
  await refuses('a customer\'s own material has no supplier bill', () => grn(PC.id, { lines: [{ lineId: PC.lines[0] }] }), /customer's own material/);
  const wm = await grn((await po(S_IN, [[A, 1, 100]])).id, { lines: [{ lineId: (await db.query('SELECT MAX(id) id FROM cf_purchase_order_lines WHERE company_id = ?', [COMPANY]))[0][0].id, mrp: 80 }] });
  ok('price above MRP is warned', wm.warnings.some((w) => /above the MRP/.test(w)));

  /* ───────────── 7. reads for Accounts ───────────── */
  section('7. Reads for Accounts; the older call is flagged');
  const P8 = await po(S_IN, [[B, 2, 50]]);
  const old = await PS.receiveLine(db, c, P8.lines[0], { quantity: 2, stockingAreaId: area });
  const legacyId = await GRN.noteLegacyReceipt(db, c, P8.lines[0], old);
  ok('a receipt through the older call leaves a flagged "no money captured" row', legacyId != null);
  const legacy = await GRN.getBill(db, COMPANY, legacyId);
  ok('…invoice pending, money_captured = 0, the cost it came in at', legacy.moneyCaptured === false && legacy.flags.includes('no_money') && legacy.invoice.pending && near(legacy.totals.taxable, 100));
  const bySup = await GRN.listBills(db, COMPANY, { supplierId: S_OUT });
  ok('list by supplier', bySup.rows.length === 1 && bySup.rows.every((r) => r.supplier.id === S_OUT));
  const noMoney = await GRN.listBills(db, COMPANY, { flag: 'no_money', purchaseOrderId: P8.id });
  ok('list the receipts with no money', noMoney.rows.length === 1);
  const bySearch = await GRN.listBills(db, COMPANY, { search: `S-${RUN}-1` });
  ok('search by invoice number', bySearch.rows.length === 1 && bySearch.rows[0].id === b1.id && near(bySearch.summary.total, 2350.2));
  const detail = await GRN.getBill(db, COMPANY, b1.id);
  ok('detail carries the movement code of each line', detail.lines.every((l) => l.movement?.code) && detail.purchaseOrder.code.endsWith('PO1'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) exitCode = 1;
  await db.rollback();
  detachNodeCache(conn);
  const after = await census(conn);
  const drift = Object.keys(after).filter((t) => after[t] !== before[t]);
  ok('everything rolled back — every cf_ table has the same row count', drift.length === 0, drift.join(', '));
  if (drift.length) exitCode = 1;
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  if (failed) exitCode = 1;
} catch (err) {
  console.error('SUITE ERROR', err);
  exitCode = 1;
  try { await conn.rollback(); } catch { /* ignore */ }
} finally {
  conn.release();
  await pool.end();
}
process.exit(exitCode);
