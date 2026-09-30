/**
 * gst_test.mjs — CF_ERP GST (TM/CF_ERP_GST_PLAN.md, init.sql §37): GSTIN check
 * digit, company tax details, HSN / rates on items and templates, the tax split
 * (CGST = SGST = half, IGST, SEZ / export with and without LUT), tax on sales
 * orders and purchase orders (reverse charge), ship → today's draft → issue →
 * gap-free numbers per financial year, problems that block issue, immutability,
 * cancel, print, the e-invoice and e-way bill files, amount in words, a tonne
 * line billed by weight, and round trips for list / detail / print.
 *
 *   cd multi_app_be && node scripts/cf_kepl/gst_test.mjs
 *   CF_GST_COMPANY=2 (default)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table. It owns its classification, items,
 * parties, stocking area and orders; every name carries the run's tag. It sets
 * the company's tax details and clears its invoice series inside that
 * transaction (both come back on rollback).
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { createItem, createDefinition, updateRecord, getRecord } from '../../apps/cf_erp/services/masterRecordService.js';
import { createOrder, addOrderLine, updateOrderLine, getOrder, listOrders } from '../../apps/cf_erp/services/salesOrderService.js';
import { createPurchaseOrder, addPurchaseLine, updatePurchaseOrder, getPurchaseOrder, listPurchaseOrders } from '../../apps/cf_erp/services/purchaseService.js';
import { postMovement } from '../../apps/cf_erp/services/stockService.js';
import { shipLine } from '../../apps/cf_erp/services/dispatchService.js';
import {
  validateGstin, putTaxSettings, getTaxSettings, taxLines, supplyOf, amountInWords, itemTaxOf, financialYear, GST_STATES,
} from '../../apps/cf_erp/services/taxService.js';
import { gstinCheckChar } from '../../apps/cf_erp/modules/parties/gstin.js';
import { createParty, updateParty, createAddress, listAddresses } from '../../apps/cf_erp/modules/parties/service.js';
import {
  getInvoice, listInvoices, createInvoice, orderInvoices, updateInvoice, removeInvoiceLine, deleteInvoice, issueInvoice, cancelInvoice,
  setIrn, addEwayBill, removeEwayBill, uninvoicedShipments,
} from '../../apps/cf_erp/services/invoiceService.js';
import { printHtml, einvoiceJson, ewaybillJson } from '../../apps/cf_erp/services/invoiceDocuments.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_GST_COMPANY ?? 2);
const tag = `GST${Date.now().toString(36).toUpperCase()}`;

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
const near = (a, b, eps = 0.005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const gstin = (first14) => first14 + gstinCheckChar(first14);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const result = await fn(); return { result, queries: n - at }; };

try {
  await conn.beginTransaction();
  const c = { companyId: COMPANY, userId: null };
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('purchase_order', 'stock_movement', 'sales_order', 'stock_lot')", [COMPANY]);
  await db.query('DELETE FROM cf_invoice_series WHERE company_id = ?', [COMPANY]);
  await db.query('UPDATE cf_company_settings SET gstin = NULL, state_code = NULL, legal_name = NULL, lut_number = NULL, gst_rates = NULL, invoice_prefix = \'INV\' WHERE company_id = ?', [COMPANY]);

  section('1. GSTIN check digit');
  ok('27AAPFU0939F1ZV is valid (Maharashtra, PAN AAPFU0939F)', (() => { const v = validateGstin('27AAPFU0939F1ZV'); return v.valid && v.stateCode === '27' && v.pan === 'AAPFU0939F' && v.stateName === 'Maharashtra'; })());
  ok('29AAGCB7383J1Z4 is valid (Karnataka)', validateGstin('29AAGCB7383J1Z4').valid && validateGstin('29AAGCB7383J1Z4').stateCode === '29');
  ok('lower case and spaces are fine: "27aapfu0939f1zv "', validateGstin(' 27aapfu 0939f1zv ').valid);
  let v = validateGstin('27AAPFU0939F1ZW');
  ok('one character changed (last) → refused, "does not add up"', !v.valid && /does not add up/.test(v.message), v.message);
  v = validateGstin('27AAPFU0938F1ZV');
  ok('one character changed (a PAN digit) → refused', !v.valid && /does not add up/.test(v.message), v.message);
  ok('14 characters → refused with the count', /15 characters — this one has 14/.test(validateGstin('27AAPFU0939F1Z').message));
  ok('state 99 → not a state code', /not a state code/.test(validateGstin(gstin('99AAPFU0939F1Z')).message));
  ok('the pattern is enforced (a digit where the PAN has a letter)', !validateGstin('271APFU0939F1ZV').valid);
  ok('state list: 01 … 38, 96, 97', GST_STATES.length >= 39 && GST_STATES.some((s) => s.code === '38' && s.name === 'Ladakh') && GST_STATES.some((s) => s.code === '96'));

  section('2. Company tax details');
  let e = await refusal(() => putTaxSettings(db, c, { gstin: '27AAPFU0939F1ZW' }));
  ok('a wrong GSTIN is refused in plain words', e?.code === 'INVALID' && says(e, /GSTIN: That GSTIN does not add up/), e?.message);
  e = await refusal(() => putTaxSettings(db, c, { gstin: '27AAPFU0939F1ZV', stateCode: '29' }));
  ok('a typed state that disagrees with the GSTIN is refused', says(e, /registered in Maharashtra/), JSON.stringify(e?.problems));
  e = await refusal(() => putTaxSettings(db, c, { invoicePrefix: 'INVOICE' }));
  ok('a prefix that would push the number past 16 characters is refused', says(e, /1 to 5 letters/), JSON.stringify(e?.problems));
  e = await refusal(() => putTaxSettings(db, c, { gstRates: [5, 'x'] }));
  ok('a rate list with a non-number is refused', says(e, /percentage from 0 to 100/));
  let tax = await putTaxSettings(db, c, {
    legalName: `${tag} Fabricators Pvt Ltd`, tradeName: `${tag} Fab`, gstin: '27aapfu0939f1zv', address1: 'Plot 12, MIDC Bhosari', city: 'Pune', pincode: '411026',
  });
  ok('saved: GSTIN upper-cased, state 27 from the GSTIN', tax.gstin === '27AAPFU0939F1ZV' && tax.stateCode === '27' && tax.stateName === 'Maharashtra', JSON.stringify(tax));
  ok('the seed rate list 0, 0.25, 3, 5, 12, 18, 28, 40; prefix INV; e-invoice required', JSON.stringify(tax.gstRates) === '[0,0.25,3,5,12,18,28,40]' && tax.invoicePrefix === 'INV' && tax.einvoiceRequired === true);
  tax = await putTaxSettings(db, c, { gstRates: [18, 5, 0, 28, 12, 40, 0.25, 3, 7.5] });
  ok('the rate list is the company\'s: 7.5 added, sorted', tax.gstRates.includes(7.5) && tax.gstRates[0] === 0);
  ok('GET returns the same', JSON.stringify(await getTaxSettings(db, COMPANY)) === JSON.stringify(tax));

  section('3. HSN / rate on items and templates');
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — gst test`],
  );
  const variant = await node(await node(await node(null, 0, 'F'), 1, 'S'), 2, 'V');
  const [[weightSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const A = (await createItem(db, c, { classificationId: variant, code: `${tag}-A`, name: `${tag} bracket`, status: 'active', listPrice: 1000.05, hsnCode: '7308', gstRate: 18 })).id;
  let rec = await getRecord(db, COMPANY, A);
  ok('created with HSN 7308 at 18% — top level and in item', rec.hsnCode === '7308' && rec.gstRate === 18 && rec.isService === false && rec.item.hsnCode === '7308' && rec.item.gstRate === 18, JSON.stringify({ h: rec.hsnCode, r: rec.gstRate }));
  const P = (await createItem(db, c, { classificationId: variant, code: `${tag}-P`, name: `${tag} girder`, status: 'active' })).id;
  await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, 500, 'kg', 'entered')", [COMPANY, weightSpec.id, P]);
  e = await refusal(() => updateRecord(db, c, P, { gstRate: 17 }));
  ok('a rate not on the company\'s list is refused', says(e, /not on the company's list/), e?.message);
  e = await refusal(() => updateRecord(db, c, P, { hsnCode: '73A8' }));
  ok('an HSN code that is not 4/6/8 digits is refused', says(e, /4, 6 or 8 digits/));
  e = await refusal(() => updateRecord(db, c, P, { hsnCode: '995411' }));
  ok('99… on goods is refused (that is a SAC)', says(e, /service code \(SAC\)/));
  e = await refusal(() => updateRecord(db, c, P, { hsnCode: '7308', isService: true }));
  ok('a service with an HSN that is not a SAC is refused', says(e, /SAC code: 6 digits starting 99/));
  rec = await updateRecord(db, c, P, { hsnCode: '73089090', gstRate: '7.5' });
  ok('an 8-digit HSN and a rate from the edited list (7.5) are accepted', rec.hsnCode === '73089090' && rec.gstRate === 7.5);
  rec = await updateRecord(db, c, P, { gstRate: 18 });
  const tmpl = (await createDefinition(db, c, { definitionType: 'template', classificationId: variant, name: `${tag} span template`, hsnCode: '7308', gstRate: 18 })).id;
  rec = await getRecord(db, COMPANY, tmpl);
  ok('a template definition carries HSN + rate (definition.hsnCode too)', rec.hsnCode === '7308' && rec.gstRate === 18 && rec.definition.gstRate === 18);
  const sel = await refusal(() => createDefinition(db, c, { definitionType: 'selection', classificationId: variant, name: `${tag} sel`, selectionMode: 'allowed_list', gstRate: 18 }));
  ok('a selection definition refuses a rate (the picked item has its own)', says(sel, /selection takes its HSN/), sel?.message);
  const noTax = (await createItem(db, c, { classificationId: variant, code: `${tag}-N`, name: `${tag} no-tax widget`, status: 'active', listPrice: 100 })).id;

  section('4. The tax split (taxService.taxLines)');
  const intra = supplyOf({ supplierState: '27', placeOfSupply: '27', registration: 'regular' });
  let t = taxLines([{ taxable: 1000.05, gstRate: 18 }], intra);
  ok('same state: CGST = SGST = half the rate, each rounded (90.00 + 90.00)', !intra.isIgst && t.lines[0].cgst === 90 && t.lines[0].sgst === 90 && t.lines[0].igst === 0, JSON.stringify(t.lines[0]));
  const inter = supplyOf({ supplierState: '27', placeOfSupply: '29', registration: 'regular' });
  t = taxLines([{ taxable: 1000.05, gstRate: 18 }], inter);
  ok('other state: IGST at the full rate (180.01)', inter.isIgst && t.lines[0].igst === 180.01 && t.lines[0].cgst === 0, JSON.stringify(t.lines[0]));
  t = taxLines([{ taxable: 1000.05, gstRate: 18 }, { taxable: 333.33, gstRate: 5 }], intra);
  ok('two lines: taxes per line then summed; rounded to the rupee with a round-off line',
    t.totals.taxable === 1333.38 && t.totals.cgst === 98.33 && t.totals.sgst === 98.33 && t.totals.beforeRounding === 1530.04 && t.totals.grandTotal === 1530 && t.totals.roundOff === -0.04, JSON.stringify(t.totals));
  t = taxLines([{ taxable: 100.5, gstRate: 18 }], intra);
  ok('an odd paisa: 100.50 × 9% = 9.045 → CGST 9.05 = SGST 9.05 (always equal)', t.lines[0].cgst === t.lines[0].sgst && t.lines[0].cgst === 9.05, JSON.stringify(t.lines[0]));
  const sezWp = supplyOf({ supplierState: '27', placeOfSupply: '27', registration: 'sez' });
  ok('SEZ in the same state is still IGST (SEZWP) without a LUT', sezWp.isIgst && !sezWp.zeroRated && sezWp.supplyType === 'SEZWP');
  const sezLut = supplyOf({ supplierState: '27', placeOfSupply: '27', registration: 'sez', lutNumber: 'AD270925000123X' });
  t = taxLines([{ taxable: 5000, gstRate: 18 }], sezLut);
  ok('SEZ under LUT: zero-rated (tax 0), SEZWOP, the LUT sentence', sezLut.zeroRated && sezLut.supplyType === 'SEZWOP' && t.totals.tax === 0 && /under LUT/.test(sezLut.note));
  const exp = supplyOf({ supplierState: '27', placeOfSupply: '96', registration: 'overseas' });
  ok('export without LUT: IGST, EXPWP', exp.isIgst && exp.supplyType === 'EXPWP' && !exp.zeroRated);
  const unreg = supplyOf({ supplierState: '27', placeOfSupply: '27', registration: 'unregistered' });
  ok('an unregistered customer: same rule by state (CGST+SGST), B2C', unreg.isIgst === false && unreg.supplyType === 'B2C');
  ok('no customer state → a problem, not a guess', !!supplyOf({ supplierState: '27', placeOfSupply: null }).problem);
  ok('financial year Apr–Mar: 2026-03-31 → 2025-26, 2026-04-01 → 2026-27', financialYear('2026-03-31') === '2025-26' && financialYear('2026-04-01') === '2026-27');

  section('5. Amount in words (Indian)');
  ok('5,68,89,502.40', amountInWords(56889502.40) === 'Rupees Five Crore Sixty Eight Lakh Eighty Nine Thousand Five Hundred Two and Forty Paise Only', amountInWords(56889502.40));
  ok('1,00,000 → One Lakh; 0.50 → Zero and Fifty Paise', amountInWords(100000) === 'Rupees One Lakh Only' && amountInWords(0.5) === 'Rupees Zero and Fifty Paise Only');
  ok('150,00,00,000 → One Hundred Fifty Crore', amountInWords(1500000000) === 'Rupees One Hundred Fifty Crore Only', amountInWords(1500000000));
  ok('1,011 → One Thousand Eleven', amountInWords(1011) === 'Rupees One Thousand Eleven Only');

  section('6. Parties: GSTIN, registration, ship-to addresses');
  e = await refusal(() => createParty(db, c, { code: `${tag}-BAD`, name: `${tag} bad`, roles: ['customer'], gstin: '29AAGCB7383J1Z5' }));
  ok('a party with a wrong GSTIN is refused', says(e, /does not add up/), JSON.stringify(e?.problems));
  const custIntra = await createParty(db, c, { code: `${tag}-CI`, name: `${tag} Pune Infra`, roles: ['customer'], gstin: gstin('27AAGCB7383J1Z'), address: 'Survey 44, Hinjewadi', city: 'Pune', pincode: '411057' });
  ok('a customer\'s GSTIN sets its state (27); gstin = taxNumber; regular by default', custIntra.stateCode === '27' && custIntra.gstin === custIntra.taxNumber && custIntra.gstRegistration === 'regular', JSON.stringify(custIntra));
  const custInter = await createParty(db, c, { code: `${tag}-CK`, name: `${tag} Bengaluru Metro`, roles: ['customer'], gstin: '29AAGCB7383J1Z4', address: 'MG Road', city: 'Bengaluru', pincode: '560001' });
  const custSez = await createParty(db, c, { code: `${tag}-CS`, name: `${tag} SEZ Unit`, roles: ['customer'], gstin: gstin('27AABCS1234K1Z'), gstRegistration: 'sez', address: 'SEZ Kharadi', city: 'Pune', pincode: '411014' });
  const custB2C = await createParty(db, c, { code: `${tag}-CU`, name: `${tag} Walk-in`, roles: ['customer'], gstRegistration: 'unregistered', stateCode: '27', city: 'Pune', pincode: '411001' });
  ok('an unregistered customer takes a typed state', custB2C.gstRegistration === 'unregistered' && custB2C.stateCode === '27');
  e = await refusal(() => updateParty(db, c, custB2C.id, { pincode: '12345' }));
  ok('a 5-digit PIN is refused', says(e, /6 digits/));
  const supplier = await createParty(db, c, { code: `${tag}-SUP`, name: `${tag} Steel Karnataka`, roles: ['supplier'], gstin: gstin('29AACCS5555L1Z') });
  let addrs = await createAddress(db, c, custIntra.id, { label: 'Site Nagpur', address: 'Butibori site', city: 'Nagpur', pincode: '441108', stateCode: '27', isDefaultShip: true });
  addrs = await createAddress(db, c, custIntra.id, { label: 'Site Goa', address: 'Verna', city: 'Verna', pincode: '403722', gstin: gstin('30AAGCB7383J1Z') });
  ok('two ship-to addresses; the Goa one takes state 30 from its GSTIN; one default', addrs.length === 2 && addrs.find((a) => a.label === 'Site Goa').stateCode === '30' && addrs.filter((a) => a.isDefaultShip).length === 1, JSON.stringify(addrs));
  const goa = addrs.find((a) => a.label === 'Site Goa');
  addrs = await createAddress(db, c, custInter.id, { label: 'Depot', address: 'Whitefield', city: 'Bengaluru', pincode: '560066', stateCode: '29', isDefaultShip: true });
  ok('listAddresses reads them back', (await listAddresses(db, COMPANY, custInter.id)).length === 1);

  section('7. Tax on a sales order (estimated, on read)');
  const soIntra = await createOrder(db, c, { orderType: 'customer', customerId: custIntra.id, code: `${tag}-SO1`, committedDate: '2099-12-31' });
  let o = await addOrderLine(db, c, soIntra.id, { recordId: A, quantity: 10 });
  o = await addOrderLine(db, c, soIntra.id, { recordId: P, quantity: 4, rate: 60000, rateBasis: 'tonne' });
  o = await addOrderLine(db, c, soIntra.id, { recordId: noTax, quantity: 1 });
  const lA = o.lines.find((l) => l.item?.id === A);
  const lP = o.lines.find((l) => l.item?.id === P);
  const lN = o.lines.find((l) => l.item?.id === noTax);
  ok('line A: taxable 10,000.50, 18%, CGST 900.05 = SGST 900.05, gross 11,800.60 (spread and line.tax)',
    lA.taxable === 10000.5 && lA.gstRate === 18 && lA.cgst === 900.05 && lA.sgst === 900.05 && lA.igst === 0 && lA.gross === 11800.6 && lA.tax?.gross === 11800.6, JSON.stringify(lA.tax));
  ok('line P priced per tonne: 4 × 0.5 t × 60,000 = 1,20,000 taxable', lP.taxable === 120000 && lP.cgst === 10800, JSON.stringify(lP.tax));
  ok('a line whose item has no rate says so ("No GST rate on the item.") and has no tax', lN.taxNote === 'No GST rate on the item.' && lN.taxTotal === null);
  ok('order total: taxable, CGST/SGST, isIgst false, place of supply = the default ship-to (27)',
    o.total.taxable === 130100.5 && o.total.cgst === 11700.05 && o.total.isIgst === false && o.total.placeOfSupply?.code === '27' && near(o.total.gross, 130100.5 + 23400.1), JSON.stringify(o.total));
  const soInter = await createOrder(db, c, { orderType: 'customer', customerId: custInter.id, code: `${tag}-SO2`, committedDate: '2099-12-31' });
  o = await addOrderLine(db, c, soInter.id, { recordId: A, quantity: 2 });
  ok('inter-state customer: IGST 360.02 on 2,000.10', o.total.isIgst === true && o.lines[0].igst === 360.02 && o.total.igst === 360.02, JSON.stringify(o.total));
  const listed = (await listOrders(db, COMPANY, { search: tag })).filter((x) => x.code.startsWith(tag));
  ok('the order list carries the same tax totals', listed.find((x) => x.id === soIntra.id)?.total.cgst === 11700.05 && listed.find((x) => x.id === soInter.id)?.total.igst === 360.02);

  section('8. Tax on a purchase order (input credit, reverse charge)');
  const po = await createPurchaseOrder(db, c, { supplierId: supplier.id, notes: `${tag} po` });
  let p = await addPurchaseLine(db, c, po.id, { itemId: A, quantity: 5, unitPrice: 200 });
  ok('Karnataka supplier → IGST 180 on 1,000; gross 1,180', p.lines[0].igst === 180 && p.lines[0].gross === 1180 && p.totals.tax === 180 && p.totals.gross === 1180 && p.reverseCharge === false, JSON.stringify(p.totals));
  p = await updatePurchaseOrder(db, c, po.id, { reverseCharge: true });
  ok('reverse charge: the tax is ours to pay — not in the supplier total', p.reverseCharge === true && p.totals.tax === 180 && p.totals.gross === 1000 && p.totals.taxPayableByUs === 180 && /Reverse charge/.test(p.lines[0].taxNote));
  const pl = (await listPurchaseOrders(db, COMPANY, { status: 'all', search: po.code })).find((x) => x.id === po.id);
  ok('the PO list shows tax and gross too', pl?.totals.tax === 180 && pl?.totals.gross === 1000, JSON.stringify(pl?.totals));

  section('9. Ship → today\'s draft invoice');
  const dispatch = await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'dispatch', 'active')", [COMPANY, `${tag}-DSP`, `${tag} dispatch`]);
  const ready = async (lineId, itemId, qty) => {
    await postMovement(db, c, { movementType: 'receipt', toAreaId: dispatch, lines: [{ itemId, quantity: qty }], reference: tag }, { fromProduction: true });
    await db.query("INSERT INTO cf_stock_reservations (company_id, requirement_id, order_line_id, item_id, batch_id, quantity, status) VALUES (?, NULL, ?, ?, NULL, ?, 'active')", [COMPANY, lineId, itemId, qty]);
  };
  await ready(lA.id, A, 10);
  await ready(lP.id, P, 4);
  const s1 = await shipLine(db, c, lA.id, { quantity: 4 });
  ok('shipping makes a draft invoice (default invoice: true)', s1.invoice?.status === 'draft' && s1.invoice.invoiceNo === null, JSON.stringify(s1.invoice));
  const s2 = await shipLine(db, c, lP.id, { quantity: 2 });
  ok('a second line on the same day lands on the SAME draft', s2.invoice?.id === s1.invoice.id);
  const s3 = await shipLine(db, c, lA.id, { quantity: 1, invoice: false });
  ok('invoice: false → no invoice', s3.invoice === null);
  let inv = await getInvoice(db, COMPANY, s1.invoice.id);
  ok('the draft has 2 lines: 4 × A and 2 × P', inv.lines.length === 2 && inv.lines[0].quantity === 4 && inv.lines[1].quantity === 2, JSON.stringify(inv.lines.map((l) => l.quantity)));
  const iP = inv.lines.find((l) => l.orderLineId === lP.id);
  ok('tonne-basis line billed by WEIGHT: 2 × 500 kg = 1 t × 60,000 = 60,000', iP.billedQty === 1 && iP.billedUom === 't' && iP.taxable === 60000 && iP.rateBasis === 'tonne', JSON.stringify(iP));
  ok('draft place of supply is the default ship-to (Nagpur, 27) → CGST+SGST', inv.placeOfSupply?.code === '27' && inv.isIgst === false && inv.shipTo?.label === 'Site Nagpur');
  ok('draft totals: 4,000.20 + 60,000 taxable; grand total rounded; words', inv.totals.taxable === 64000.2 && inv.totals.grandTotal === Math.round(64000.2 * 1.18) && /^Rupees .* Only$/.test(inv.totals.inWords), JSON.stringify(inv.totals));
  ok('draft lists the un-invoiced shipment (the invoice:false one)', inv.uninvoicedShipments?.length === 1 && inv.uninvoicedShipments[0].quantity === 1);
  ok('no problems: it can be issued', inv.problems.length === 0, JSON.stringify(inv.problems));
  let oi = await orderInvoices(db, COMPANY, soIntra.id);
  ok('GET /orders/:id/invoices: 1 invoice, 1 uninvoiced shipment', oi.rows.length === 1 && oi.uninvoiced.length === 1 && oi.uninvoiced[0].lineNo === lA.lineNo, JSON.stringify(oi.uninvoiced));
  e = await refusal(() => createInvoice(db, c, soIntra.id, { movementIds: [s1.movement.id] }));
  ok('a shipment already on an invoice cannot be invoiced twice', e?.code === 'NOT_UNINVOICED', e?.message);
  const draft2 = await createInvoice(db, c, soIntra.id, {});
  ok('POST /orders/:id/invoices takes the un-invoiced shipment onto a new draft', draft2.status === 'draft' && draft2.lines.length === 1 && draft2.lines[0].quantity === 1);
  e = await refusal(() => createInvoice(db, c, soIntra.id, {}));
  ok('...and then there is nothing left to invoice', e?.code === 'NOTHING_TO_INVOICE');
  await deleteInvoice(db, c, draft2.id);
  ok('deleting a draft frees its shipment', (await uninvoicedShipments(db, COMPANY, soIntra.id)).length === 1);

  section('10. Editing a draft');
  inv = await updateInvoice(db, c, inv.id, { shipToAddressId: goa.id });
  ok('ship-to Goa (30): place of supply 30 → IGST', inv.placeOfSupply?.code === '30' && inv.isIgst === true && inv.totals.igst > 0 && inv.totals.cgst === 0);
  inv = await updateInvoice(db, c, inv.id, { shipToAddressId: null });
  ok('ship-to cleared → the customer\'s own state (27), CGST+SGST', inv.placeOfSupply?.code === '27' && inv.isIgst === false && inv.shipTo === null);
  e = await refusal(() => updateInvoice(db, c, inv.id, { shipToAddressId: addrs[0].id }));
  ok('another customer\'s address is refused', says(e, /not one of the customer's addresses/));
  e = await refusal(() => updateInvoice(db, c, inv.id, { invoiceDate: '2099-01-01' }));
  ok('a future invoice date is refused', says(e, /future/));
  e = await refusal(() => updateInvoice(db, c, inv.id, { transport: { mode: 'boat' } }));
  ok('a bad transport mode is refused', says(e, /road, rail, air or ship/));
  inv = await updateInvoice(db, c, inv.id, { transport: { mode: 'road', vehicleNo: 'mh 12 ab 1234', distanceKm: 780, transporter: 'Fast Roadways' }, notes: 'Handle with care' });
  ok('transport saved (vehicle normalised); notes', inv.transport?.vehicleNo === 'MH12AB1234' && inv.transport?.distanceKm === 780 && inv.notes === 'Handle with care');

  section('11. Issue — blocked by problems, then numbered gap-free');
  await db.query('UPDATE cf_company_settings SET gstin = NULL WHERE company_id = ?', [COMPANY]);
  await db.query('UPDATE cf_item_details SET hsn_code = NULL, gst_rate = NULL WHERE master_id = ?', [P]);
  inv = await getInvoice(db, COMPANY, inv.id);
  const texts = inv.problems.map((x) => x.text);
  ok('problems name what to fill: company GSTIN, the item\'s HSN and GST rate', texts.includes('Company GSTIN not set.') && texts.some((x) => /girder has no HSN code/.test(x)) && texts.some((x) => /girder has no GST rate/.test(x)), JSON.stringify(texts));
  ok('each problem carries where to fix it (company-tax, items/<id>)', inv.problems.find((x) => x.text === 'Company GSTIN not set.')?.fix?.to === 'company-tax' && inv.problems.find((x) => /no HSN/.test(x.text))?.fix?.to === `items/${P}`);
  e = await refusal(() => issueInvoice(db, c, inv.id));
  ok('issue is refused with every problem at once (and detail with fix links)', e?.code === 'CANNOT_ISSUE' && e.problems.length >= 3 && Array.isArray(e.detail) && !!e.detail[0].text, JSON.stringify(e?.problems));
  const [[stillDraft]] = await db.query('SELECT status, invoice_no FROM cf_invoices WHERE id = ?', [inv.id]);
  ok('...and nothing was numbered', stillDraft.status === 'draft' && stillDraft.invoice_no === null);
  await putTaxSettings(db, c, { gstin: '27AAPFU0939F1ZV' });
  await updateRecord(db, c, P, { hsnCode: '7308', gstRate: 18 });
  const draftTotal = (await getInvoice(db, COMPANY, inv.id)).totals.grandTotal;
  inv = await issueInvoice(db, c, inv.id);
  ok('issued: INV/26-27/0001 (≤ 16 chars), dated today, FY 2026-27', inv.status === 'issued' && inv.invoiceNo === `INV/${financialYear(new Date().toISOString().slice(0, 10)).slice(2, 4)}-${financialYear(new Date().toISOString().slice(0, 10)).slice(5)}/0001` && inv.invoiceNo.length <= 16 && inv.fy === financialYear(inv.invoiceDate), `${inv.invoiceNo} ${inv.fy}`);
  ok('the issued totals are the draft\'s', inv.totals.grandTotal === draftTotal && inv.problems.length === 0);
  ok('snapshots frozen: supplier GSTIN, buyer, ship-to (= buyer)', inv.supplier.gstin === '27AAPFU0939F1ZV' && inv.buyer.name === custIntra.name && inv.shipTo?.sameAsBuyer === true && inv.supplyType === 'B2B');
  const firstId = inv.id;
  // A second invoice, same year.
  const s4 = await shipLine(db, c, lA.id, { quantity: 2 });
  ok('a new shipment goes on a NEW draft (the day\'s draft is issued)', s4.invoice.id !== firstId);
  const inv2 = await issueInvoice(db, c, s4.invoice.id);
  ok('the next number: …/0002', inv2.invoiceNo.endsWith('/0002'), inv2.invoiceNo);
  // FY rollover: an invoice dated in the previous year starts that year's series.
  const s5 = await shipLine(db, c, lA.id, { quantity: 1 });
  await updateInvoice(db, c, s5.invoice.id, { invoiceDate: '2026-03-31' });
  const inv3 = await issueInvoice(db, c, s5.invoice.id);
  ok('dated 31-03-2026 → FY 2025-26, INV/25-26/0001', inv3.invoiceNo === 'INV/25-26/0001' && inv3.fy === '2025-26', inv3.invoiceNo);
  const [series] = await db.query('SELECT fy, next_no FROM cf_invoice_series WHERE company_id = ? ORDER BY fy', [COMPANY]);
  ok('two series rows, next numbers 2 and 3', series.length === 2 && Number(series[0].next_no) === 2 && Number(series[1].next_no) === 3, JSON.stringify(series));

  section('12. Issued invoices never change');
  await updateOrderLine(db, c, lA.id, { rate: 999999 });
  await db.query('UPDATE cf_parties SET name = ? WHERE id = ?', [`${tag} renamed`, custIntra.id]);
  await putTaxSettings(db, c, { legalName: `${tag} Renamed Ltd` });
  let again = await getInvoice(db, COMPANY, firstId);
  ok('after the rate, the customer name and the company name change, the issued invoice reads the same',
    again.totals.grandTotal === draftTotal && again.buyer.name === custIntra.name && again.supplier.legalName === `${tag} Fabricators Pvt Ltd` && again.lines[0].rate === 1000.05, JSON.stringify({ g: again.totals.grandTotal, b: again.buyer.name }));
  e = await refusal(() => updateInvoice(db, c, firstId, { invoiceDate: '2026-09-01' }));
  ok('an issued invoice\'s date cannot change (409 ISSUED)', e?.code === 'ISSUED', e?.message);
  e = await refusal(() => updateInvoice(db, c, firstId, { notes: 'x' }));
  ok('...nor its notes', e?.code === 'ISSUED');
  e = await refusal(() => removeInvoiceLine(db, c, firstId, again.lines[0].id));
  ok('...nor its lines', e?.code === 'ISSUED');
  e = await refusal(() => deleteInvoice(db, c, firstId));
  ok('...and it cannot be deleted', e?.code === 'ISSUED');
  e = await refusal(() => issueInvoice(db, c, firstId));
  ok('...or issued twice', e?.code === 'ISSUED');
  again = await updateInvoice(db, c, firstId, { transport: { mode: 'road', vehicleNo: 'MH14XY9876', distanceKm: 780 } });
  ok('transport CAN change after issue (logistics, not the tax document)', again.transport.vehicleNo === 'MH14XY9876' && again.invoiceNo.endsWith('/0001'));
  await updateOrderLine(db, c, lA.id, { rate: 1000.05 });

  section('13. IRN and e-way bills');
  e = await refusal(() => setIrn(db, c, firstId, { irn: 'abc' }));
  ok('an IRN that is not 64 hex characters is refused', says(e, /64 characters/));
  const irn = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
  again = await setIrn(db, c, firstId, { irn, ackNo: '112010036563310', ackDate: '2026-09-30 11:05:00', signedQr: 'eyJhbGciOi.signed.qr' });
  ok('IRN, Ack no, Ack date (YYYY-MM-DD HH:mm:ss) and signed QR saved; irn is the string', again.irn === irn && again.ackNo === '112010036563310' && !!again.ackDate && !!again.signedQr);
  e = await refusal(() => addEwayBill(db, c, firstId, { ewayNo: '12345' }));
  ok('an e-way bill number that is not 12 digits is refused', says(e, /12 digits/));
  again = await addEwayBill(db, c, firstId, { ewayNo: '331000123456', vehicleNo: 'MH14XY9876', validUntil: '2026-10-02T23:59:00' });
  again = await addEwayBill(db, c, firstId, { ewayNo: '331000123457', vehicleNo: 'MH14XY9877', validUntil: '2026-10-02 23:59:00' });
  ok('two e-way bills (two vehicles); ISO and space dates accepted', again.ewayBills.length === 2 && again.ewayBills[0].ewayNo === '331000123456');
  again = await removeEwayBill(db, c, firstId, again.ewayBills[1].id);
  ok('one removed', again.ewayBills.length === 1);
  e = await refusal(() => setIrn(db, c, s5.invoice.id + 0, { irn: '' }));
  ok('(IRN on an issued invoice may be cleared)', e === null);
  const draftForIrn = await shipLine(db, c, lP.id, { quantity: 1 });
  e = await refusal(() => setIrn(db, c, draftForIrn.invoice.id, { irn }));
  ok('a draft takes no IRN', e?.code === 'NOT_ISSUED');

  section('14. Documents');
  again = await getInvoice(db, COMPANY, firstId);
  const html = printHtml(again, 'duplicate');
  const has = (s) => html.includes(s);
  ok('print: TAX INVOICE, copy label, invoice no and date (dd/mm/yyyy)', has('TAX INVOICE') && has('Duplicate for Transporter') && has(again.invoiceNo) && has(again.invoiceDate.split('-').reverse().join('/')));
  ok('print: supplier name, address and GSTIN; buyer name, GSTIN, state + code', has(`${tag} Fabricators Pvt Ltd`) && has('27AAPFU0939F1ZV') && has('MIDC Bhosari') && has(custIntra.name) && has(custIntra.gstin) && has('Maharashtra (27)'));
  ok('print: place of supply, reverse charge "No", HSN, rate, taxable, CGST and SGST columns', has('Place of supply') && has('Whether tax is payable on reverse charge: <b>No</b>') && has('7308') && has('CGST %') && has('SGST ₹'));
  ok('print: totals, round off, grand total in words, signature, IRN, e-way bill, transport', has('Round off') && has(again.totals.inWords) && has('Authorised Signatory') && has(`for <b>${tag} Fabricators Pvt Ltd</b>`) && has(irn) && has('331000123456') && has('MH14XY9876'));
  ok('print: no external assets (no http links, no <script>, no <link>)', !/https?:\/\//.test(html) && !/<script|<link/i.test(html));
  ok('print of a draft says DRAFT, not a tax invoice', printHtml(await getInvoice(db, COMPANY, draftForIrn.invoice.id)).includes('DRAFT — not a tax invoice'));
  const ej = einvoiceJson(again);
  ok('e-invoice: Version 1.1, TranDtls B2B/RegRev N, DocDtls INV + No + dd/mm/yyyy', ej.Version === '1.1' && ej.TranDtls.TaxSch === 'GST' && ej.TranDtls.SupTyp === 'B2B' && ej.TranDtls.RegRev === 'N' && ej.DocDtls.Typ === 'INV' && ej.DocDtls.No === again.invoiceNo && /^\d{2}\/\d{2}\/\d{4}$/.test(ej.DocDtls.Dt));
  ok('e-invoice: SellerDtls / BuyerDtls (Gstin, LglNm, Pin number, Stcd, Pos)', ej.SellerDtls.Gstin === '27AAPFU0939F1ZV' && ej.SellerDtls.Pin === 411026 && ej.SellerDtls.Stcd === '27' && ej.BuyerDtls.Gstin === custIntra.gstin && ej.BuyerDtls.Pos === '27' && ej.BuyerDtls.Pin === 411057);
  const items = ej.ItemList;
  ok('e-invoice ItemList: SlNo, HsnCd, Unit NOS and MTS (tonne), Qty billed, GstRt', items.length === 2 && items[0].SlNo === '1' && items[0].Unit === 'NOS' && items[1].Unit === 'MTS' && items[1].Qty === 1 && items[1].GstRt === 18 && items[0].HsnCd === '7308', JSON.stringify(items.map((i) => [i.Unit, i.Qty])));
  const sumAss = items.reduce((s, i) => s + i.AssAmt, 0);
  const sumItem = items.reduce((s, i) => s + i.TotItemVal, 0);
  ok('e-invoice reconciles: AssVal = Σ AssAmt; TotInvVal = Σ TotItemVal + RndOffAmt; CGST = SGST',
    near(ej.ValDtls.AssVal, sumAss) && near(ej.ValDtls.TotInvVal, sumItem + ej.ValDtls.RndOffAmt) && ej.ValDtls.CgstVal === ej.ValDtls.SgstVal && ej.ValDtls.TotInvVal === again.totals.grandTotal, JSON.stringify(ej.ValDtls));
  ok('e-invoice: each item TotAmt ≈ Qty × UnitPrice', items.every((i) => near(i.TotAmt, i.Qty * i.UnitPrice, 0.5)));
  ok('e-invoice: EwbDtls from transport (Distance, VehNo, TransMode 1)', ej.EwbDtls?.Distance === 780 && ej.EwbDtls?.VehNo === 'MH14XY9876' && ej.EwbDtls?.TransMode === '1');
  const eb = ewaybillJson(again);
  const bill = eb.billLists[0];
  ok('e-way bill: version 1.0.0621, supplyType O, subSupplyType 1, docType INV', eb.version === '1.0.0621' && bill.supplyType === 'O' && bill.subSupplyType === 1 && bill.docType === 'INV' && bill.docNo === again.invoiceNo);
  ok('e-way bill: from/to GSTIN, state, pincode; totals reconcile', bill.fromGstin === '27AAPFU0939F1ZV' && bill.toGstin === custIntra.gstin && bill.fromStateCode === 27 && bill.toPincode === 411057
    && near(bill.totalValue + bill.cgstValue + bill.sgstValue + bill.igstValue + bill.otherValue, bill.totInvValue));
  ok('e-way bill itemList: hsnCode, quantity, qtyUnit, taxableAmount, cgstRate 9 / sgstRate 9', bill.itemList.length === 2 && bill.itemList[0].hsnCode === 7308 && bill.itemList[0].cgstRate === 9 && bill.itemList[0].igstRate === 0 && bill.itemList[1].qtyUnit === 'MTS');
  ok('e-way bill: transMode 1, distance "780", vehicle, vehicleType R', bill.transMode === 1 && bill.transDistance === '780' && bill.vehicleNo === 'MH14XY9876' && bill.vehicleType === 'R');
  const inv2full = await getInvoice(db, COMPANY, inv2.id);
  e = await refusal(() => ewaybillJson(inv2full));
  ok('no transport → the e-way bill file is refused (400) with what to enter', e?.status === 400 && says(e, /Transport mode is not set/), e?.message);
  e = await refusal(async () => einvoiceJson(await getInvoice(db, COMPANY, draftForIrn.invoice.id)));
  ok('a draft has no e-invoice file', e?.status === 400 && says(e, /Issue the invoice first/));

  section('15. B2C, SEZ with and without LUT, on invoices');
  const soB2C = await createOrder(db, c, { orderType: 'customer', customerId: custB2C.id, code: `${tag}-SO3`, committedDate: '2099-12-31' });
  o = await addOrderLine(db, c, soB2C.id, { recordId: A, quantity: 1 });
  await ready(o.lines[0].id, A, 1);
  const sb = await shipLine(db, c, o.lines[0].id, {});
  const b2c = await issueInvoice(db, c, sb.invoice.id);
  ok('an unregistered customer\'s invoice issues (B2C, CGST+SGST)', b2c.supplyType === 'B2C' && b2c.totals.cgst === 90);
  e = await refusal(() => einvoiceJson(b2c));
  ok('...and has no e-invoice file', says(e, /not registered for GST/));
  const soSez = await createOrder(db, c, { orderType: 'customer', customerId: custSez.id, code: `${tag}-SO4`, committedDate: '2099-12-31' });
  o = await addOrderLine(db, c, soSez.id, { recordId: A, quantity: 2 });
  await ready(o.lines[0].id, A, 2);
  const sz = await shipLine(db, c, o.lines[0].id, { quantity: 1 });
  let sezInv = await getInvoice(db, COMPANY, sz.invoice.id);
  ok('SEZ customer, no LUT: IGST even in the same state (SEZWP)', sezInv.isIgst === true && sezInv.supplyType === 'SEZWP' && sezInv.totals.igst === 180.01);
  await putTaxSettings(db, c, { lutNumber: 'AD270925000123X' });
  sezInv = await issueInvoice(db, c, sz.invoice.id);
  ok('with the company LUT: zero-rated, SEZWOP, "under LUT" on the invoice; e-invoice SEZWOP with 0 tax',
    sezInv.totals.tax === 0 && sezInv.supplyType === 'SEZWOP' && /under LUT/.test(sezInv.taxNote) && sezInv.lutNumber === 'AD270925000123X' && einvoiceJson(sezInv).TranDtls.SupTyp === 'SEZWOP' && einvoiceJson(sezInv).ValDtls.IgstVal === 0);
  ok('print says the LUT sentence', printHtml(sezInv).includes('Supply meant for export/SEZ under LUT'));
  await putTaxSettings(db, c, { lutNumber: '' });

  section('16. Cancel');
  e = await refusal(() => cancelInvoice(db, c, inv2.id, {}));
  ok('a reason is required', says(e, /Say why/));
  const cancelled = await cancelInvoice(db, c, inv2.id, { reason: 'Wrong vehicle' });
  ok('cancelled keeps its number', cancelled.status === 'cancelled' && cancelled.invoiceNo === inv2.invoiceNo && cancelled.cancelledReason === 'Wrong vehicle');
  const freed = await uninvoicedShipments(db, COMPANY, soIntra.id);
  ok('its shipment is free again', freed.some((s) => s.movementId === s4.movement.id));
  const reinv = await createInvoice(db, c, soIntra.id, { movementIds: [s4.movement.id] });
  const reissued = await issueInvoice(db, c, reinv.id);
  const seriesNow = (await getInvoice(db, COMPANY, firstId)).invoiceNo.slice(0, -4);
  ok('re-invoiced: the next number in the series (the cancelled one is never reused)', reissued.invoiceNo !== inv2.invoiceNo && reissued.invoiceNo.startsWith(seriesNow), reissued.invoiceNo);
  e = await refusal(() => cancelInvoice(db, c, inv2.id, { reason: 'again' }));
  ok('cancelling twice is refused', e?.code === 'CANCELLED');
  e = await refusal(() => cancelInvoice(db, c, draftForIrn.invoice.id, { reason: 'x' }));
  ok('a draft is deleted, not cancelled', e?.code === 'DRAFT');

  section('17. The template fallback (a custom line\'s root)');
  const [tm] = await db.query(
    "INSERT INTO cf_master_records (company_id, record_kind, name, classification_id, status) VALUES (?, 'item', ?, ?, 'draft')",
    [COMPANY, `${tag} temp root`, variant],
  );
  await db.query(
    "INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, source_definition_id, owner_order_line_id) VALUES (?, ?, 'temporary', 'individual', 'nos', 'make', ?, ?)",
    [tm.insertId, COMPANY, tmpl, lA.id],
  );
  const fb = (await itemTaxOf(db, COMPANY, [tm.insertId])).get(tm.insertId);
  ok('a temporary item with no HSN of its own takes its template\'s (7308, 18)', fb?.hsnCode === '7308' && fb?.gstRate === 18, JSON.stringify(fb));
  e = await refusal(() => updateRecord(db, c, tm.insertId, { gstRate: 18 }));
  ok('a row of an order refuses a rate of its own', says(e, /takes its HSN code and GST rate from its template|locked|released/), e?.message);

  section('18. Round trips (production is ~49 ms each)');
  let m = await measured(() => getInvoice(db, COMPANY, firstId));
  ok(`issued invoice detail: ${m.queries} round trips (≤ 4)`, m.queries <= 4);
  m = await measured(() => getInvoice(db, COMPANY, draftForIrn.invoice.id));
  ok(`draft invoice detail: ${m.queries} round trips (≤ 9)`, m.queries <= 9);
  m = await measured(() => listInvoices(db, COMPANY, {}));
  ok(`invoice list (${m.result.rows.length} rows, drafts among them): ${m.queries} round trips (≤ 7)`, m.queries <= 7);
  m = await measured(async () => printHtml(await getInvoice(db, COMPANY, firstId)));
  ok(`print: ${m.queries} round trips (≤ 4)`, m.queries <= 4);
  m = await measured(() => getOrder(db, COMPANY, soIntra.id));
  const mOrderTax = m.queries;
  ok(`order detail with tax: ${mOrderTax} round trips (tax adds 3)`, mOrderTax <= 12, String(mOrderTax));
  const lr = await measured(() => orderInvoices(db, COMPANY, soIntra.id));
  ok(`order invoices: ${lr.queries} round trips (≤ 9)`, lr.queries <= 9);
  const listShape = lr.result.rows[0];
  ok('summary shape: invoiceNo, status, invoiceDate, order, customer, taxable, tax, grandTotal, irn (bool), ewayBills (count)',
    ['id', 'invoiceNo', 'status', 'invoiceDate', 'order', 'customer', 'taxable', 'tax', 'grandTotal', 'irn', 'ewayBills'].every((k) => k in listShape)
    && typeof (lr.result.rows.find((r) => r.id === firstId)?.irn) === 'boolean' && lr.result.rows.find((r) => r.id === firstId)?.ewayBills === 1);
  const q = await listInvoices(db, COMPANY, { q: 'INV/25-26' });
  ok('search by number', q.rows.some((r) => r.id === inv3.id));
  const st = await listInvoices(db, COMPANY, { status: 'cancelled', customerId: custIntra.id });
  ok('filter by status and customer', st.rows.length === 1 && st.rows[0].id === inv2.id);
} catch (err) {
  failed++;
  console.error('\nCRASHED:', err);
} finally {
  await conn.rollback();
  conn.release();
}
const after = await counts();
const changed = after.filter((a) => Number(before.find((b) => b.name === a.name)?.n) !== Number(a.n));
ok('every cf_ table has the count it started with', changed.length === 0, changed.map((x) => x.name).join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
