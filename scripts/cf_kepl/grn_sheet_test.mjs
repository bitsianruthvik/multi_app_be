/**
 * grn_sheet_test.mjs — "Receive against PO" by Excel (services/grnSheetService.js; routes/grn.js …/grn-sheet).
 *
 *   cd multi_app_be && node scripts/cf_kepl/grn_sheet_test.mjs
 *   CF_GRN_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. The fixture is this run's own (tagged).
 *
 *   1  download: header block (PO no., supplier, store, invoice …), one row per pending line, qty = pending, price = PO's
 *   2  dry run: ok, the plan, and NOTHING written (bills, movements, ledger, qty received, batches)
 *   3  round trip: ONE GRN through receiveGrn, a new batch from the heat / lot no., the PO closes
 *   4  a prepared file on a SECOND PO with the same items: matched by item code, "file made for … applying to …" note,
 *      partial on the bigger line; "Add to batch" by an existing batch code
 *   5  partial receipt: 0 / blank rows left out; the next download shows what is still pending
 *   6  refusals, every one at once: over pending, unknown item, a dispatch store, unknown store, no invoice, batch item
 *      without a lot, an unknown batch code, a PO not yet ordered (found by the booking inside the savepoint)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const SHEET = await imp('apps/cf_erp/services/grnSheetService.js');

const COMPANY = Number(process.env.CF_GRN_COMPANY ?? 2);
const RUN = `GSH${Date.now().toString(36).toUpperCase()}`;
let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 0.005) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const section = (t) => console.log(`\n${t}`);
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}

/** Opens a downloaded sheet, lets `edit` change it by labels / item codes, and returns it as base64. */
async function fill(buffer, { head = {}, rows = {} } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('GRN');
  let headRow = null;
  for (let i = 1; i <= ws.rowCount; i += 1) {
    const a = String(ws.getCell(i, 1).value ?? '');
    if (a === SHEET.COL.code) { headRow = i; break; }
    const key = Object.keys(SHEET.HEAD).find((k) => SHEET.HEAD[k] === a);
    if (key && key in head) ws.getCell(i, 2).value = head[key];
  }
  const cols = {};
  ws.getRow(headRow).eachCell((cell, col) => { const k = Object.keys(SHEET.COL).find((x) => SHEET.COL[x] === cell.value); if (k) cols[k] = col; });
  for (let i = headRow + 1; i <= ws.rowCount; i += 1) {
    const code = String(ws.getCell(i, cols.code).value ?? '');
    for (const [k, v] of Object.entries(rows[code] ?? {})) ws.getCell(i, cols[k]).value = v;
  }
  for (const [code, vals] of Object.entries(rows)) {
    if (!code.startsWith('+')) continue;   // an extra row the file adds
    const r = ws.rowCount + 1;
    ws.getCell(r, cols.code).value = code.slice(1);
    for (const [k, v] of Object.entries(vals)) ws.getCell(r, cols[k]).value = v;
  }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
async function readBack(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('GRN');
  const head = {};
  let headRow = null;
  for (let i = 1; i <= ws.rowCount; i += 1) {
    const a = String(ws.getCell(i, 1).value ?? '');
    if (a === SHEET.COL.code) { headRow = i; break; }
    const key = Object.keys(SHEET.HEAD).find((k) => SHEET.HEAD[k] === a);
    if (key) head[key] = { value: ws.getCell(i, 2).value, grey: ws.getCell(i, 2).fill?.fgColor?.argb === 'FFEFEFEF' };
  }
  const cols = {};
  ws.getRow(headRow).eachCell((cell, col) => { const k = Object.keys(SHEET.COL).find((x) => SHEET.COL[x] === cell.value); if (k) cols[k] = col; });
  const rows = [];
  for (let i = headRow + 1; i <= ws.rowCount; i += 1) {
    const r = {};
    for (const [k, col] of Object.entries(cols)) r[k] = ws.getCell(i, col).value;
    r.pendingGrey = ws.getCell(i, cols.pending).fill?.fgColor?.argb === 'FFEFEFEF';
    r.qtyWhite = ws.getCell(i, cols.qty).fill?.fgColor?.argb !== 'FFEFEFEF';
    if (r.code) rows.push(r);
  }
  return { head, rows, cols };
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
  const node = (parent, depth, key) => ins("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')", [COMPANY, parent, depth, `${RUN}-${key}`, `${RUN} ${key}`]);
  const fam = await node(null, 0, 'FAM'); const sub = await node(fam, 1, 'SUB'); const variant = await node(sub, 2, 'VAR');
  const item = async (key, hsn, rate, tracked = 'quantity') => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, 'item', ?, ?, ?, 'active')", [COMPANY, `${RUN}-${key}`, `${RUN} ${key}`, variant]);
    await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, hsn_code, gst_rate) VALUES (?, ?, 'catalog', ?, 'nos', 'stock', ?, ?)", [id, COMPANY, tracked, hsn, rate]);
    return id;
  };
  const A = await item('A', '7208', 18);
  const B = await item('B', '7306', 12);
  const BT = await item('BT', '7208', 18, 'batch');
  const CODE = { A: `${RUN}-A`, B: `${RUN}-B`, BT: `${RUN}-BT` };
  const ST = `${RUN}-ST`;
  const DS = `${RUN}-DS`;
  await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'storage', 'active')", [COMPANY, ST, `${RUN} Store`]);
  await ins("INSERT INTO cf_stocking_areas (company_id, code, name, purpose, status) VALUES (?, ?, ?, 'dispatch', 'active')", [COMPANY, DS, `${RUN} Dispatch`]);
  const S_IN = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status, state_code, gst_registration) VALUES (?, ?, ?, 1, 'active', ?, 'regular')", [COMPANY, `${RUN}-SIN`, `${RUN} Supplier`, COMPANY_STATE]);
  let poNo = 0;
  const po = async (lines, status = 'ordered') => {
    const code = `${RUN}-PO${++poNo}`;
    const id = await ins('INSERT INTO cf_purchase_orders (company_id, code, supplier_id, status) VALUES (?, ?, ?, ?)', [COMPANY, code, S_IN, status]);
    const out = [];
    let n = 0;
    for (const [itemId, qty, price] of lines) out.push(await ins("INSERT INTO cf_purchase_order_lines (company_id, purchase_order_id, line_no, item_id, quantity, uom, unit_price) VALUES (?, ?, ?, ?, ?, 'nos', ?)", [COMPANY, id, ++n, itemId, qty, price]));
    return { id, code, lines: out };
  };
  const received = async (lineId) => Number((await db.query('SELECT qty_received FROM cf_purchase_order_lines WHERE id = ?', [lineId]))[0][0].qty_received);
  const poStatus = async (id) => (await db.query('SELECT status FROM cf_purchase_orders WHERE id = ?', [id]))[0][0].status;
  const counts = async () => {
    const q = async (sql) => Number((await db.query(sql, [COMPANY]))[0][0].n);
    return {
      bills: await q('SELECT COUNT(*) n FROM cf_grn_bills WHERE company_id = ?'),
      billLines: await q('SELECT COUNT(*) n FROM cf_grn_bill_lines WHERE company_id = ?'),
      moves: await q('SELECT COUNT(*) n FROM cf_stock_movements WHERE company_id = ?'),
      ledger: await q('SELECT COUNT(*) n FROM cf_stock_ledger WHERE company_id = ?'),
      batches: await q('SELECT COUNT(*) n FROM cf_stock_batches WHERE company_id = ?'),
      received: await q('SELECT COALESCE(SUM(qty_received), 0) * 1000000 n FROM cf_purchase_order_lines WHERE company_id = ?'),
    };
  };
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const imp1 = (poId, fileBase64, dryRun) => SHEET.importGrnSheet(db, c, poId, { fileBase64, dryRun });
  const goodHead = (n) => ({ store: ST, reference: `DN-${RUN}-${n}`, invoiceNo: `INV-${RUN}-${n}`, invoiceDate: '2026-10-30', toFollow: 'No', freight: 100, freightGst: 18 });

  /* ───────────── 1. download ───────────── */
  section('1. Download');
  const P1 = await po([[A, 10, 100], [B, 5, 200], [BT, 4, 50]]);
  const x1 = await SHEET.exportGrnSheet(db, COMPANY, P1.id);
  ok('an .xlsx named after the PO', x1.filename === `GRN_${P1.code}.xlsx` && x1.contentType.includes('spreadsheetml') && x1.buffer.length > 1000);
  const s1 = await readBack(x1.buffer);
  ok('PO no. in the header, grey', s1.head.po?.value === P1.code && s1.head.po.grey);
  ok('supplier in the header, grey', s1.head.supplier?.value === `${RUN} Supplier` && s1.head.supplier.grey);
  ok('store code prefilled with an active store, white', typeof s1.head.store?.value === 'string' && s1.head.store.value.length > 0 && !s1.head.store.grey);
  ok('invoice to follow defaults to No', s1.head.toFollow?.value === 'No');
  ok('every header label is there', Object.keys(SHEET.HEAD).every((k) => k in s1.head));
  ok('one row per pending line, in line order', s1.rows.length === 3 && s1.rows.map((r) => r.code).join(',') === [CODE.A, CODE.B, CODE.BT].join(','));
  const rA = s1.rows[0];
  ok('pending (grey) and receive qty (white, = pending)', rA.pending === 10 && rA.qty === 10 && rA.pendingGrey && rA.qtyWhite, JSON.stringify(rA));
  ok('unit price from the PO, HSN / GST from the item', rA.price === 100 && rA.hsn === '7208' && rA.gst === 18 && rA.uom === 'nos' && rA.name === `${RUN} A`);
  ok('a lot and an "add to batch" column', !!s1.cols.lot && !!s1.cols.batch);

  /* ───────────── 2. dry run ───────────── */
  section('2. Dry run writes nothing');
  const f1 = await fill(x1.buffer, { head: goodHead(1), rows: { [CODE.BT]: { lot: `HEAT-${RUN}` } } });
  const c0 = await counts();
  const census0 = await census(db);
  const d1 = await imp1(P1.id, f1, true);
  ok('the preview is ok, no problems', d1.ok === true && d1.problems.length === 0 && d1.dryRun === true && d1.applied === false, JSON.stringify(d1.problems));
  ok('three lines planned with their quantities', d1.changes.length === 3 && d1.changes.map((x) => x.quantity).join(',') === '10,5,4');
  ok('the batch line names its new lot', d1.changes[2].batch === `new · HEAT-${RUN}`);
  // goods 1000 + 1000 + 200 = 2200; GST 18% on 1200 = 216, 12% on 1000 = 120; freight 100 + 18 = 118 → 2654
  ok('the bill total is worked out (2,654.00)', near(d1.summary.total, 2654), String(d1.summary.total));
  ok('the sentence says what would be booked', /Would book one GRN on .*3 lines/.test(d1.summary.sentence), d1.summary.sentence);
  ok('no note on the PO it was made for', !d1.notes.some((n) => /File made for/.test(n)));
  ok('nothing written: bills, movements, ledger, batches, qty received', same(c0, await counts()));
  const census1 = await census(db);
  ok('…and every cf_ table holds the same row count', Object.keys(census1).every((t) => census1[t] === census0[t]));

  /* ───────────── 3. round trip ───────────── */
  section('3. Round trip — one GRN');
  const a1 = await imp1(P1.id, f1, false);
  ok('applied', a1.ok === true && a1.applied === true, JSON.stringify(a1.problems));
  ok('ONE bill with three lines and three receipts', !!a1.bill && a1.bill.lineCount === 3 && a1.movements.length === 3);
  const c1 = await counts();
  ok('exactly one bill more', c1.bills === c0.bills + 1 && c1.billLines === c0.billLines + 3);
  ok('invoice and delivery note kept', a1.bill.invoice.no === `INV-${RUN}-1` && a1.bill.invoice.date === '2026-10-30' && !a1.bill.invoice.pending);
  ok('freight kept as taxable at 18%', near(a1.bill.charges.freight.amount, 100) && a1.bill.charges.freight.taxable && near(a1.bill.charges.freight.gstRate, 18));
  ok('bill total = the preview\'s', near(a1.bill.totals.total, d1.summary.total));
  ok('every line received in full', (await received(P1.lines[0])) === 10 && (await received(P1.lines[1])) === 5 && (await received(P1.lines[2])) === 4);
  ok('the PO is received', (await poStatus(P1.id)) === 'received');
  const [[heat]] = await db.query('SELECT id, code, supplier_ref FROM cf_stock_batches WHERE company_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1', [COMPANY, BT]);
  ok('a new batch carries the heat / lot no.', heat?.supplier_ref === `HEAT-${RUN}`);
  const [[led]] = await db.query('SELECT a.code FROM cf_stock_ledger k JOIN cf_stocking_areas a ON a.id = k.stocking_area_id WHERE k.movement_id = ? LIMIT 1', [a1.movements[0].id]);
  ok('into the store named by code', led?.code === ST);

  /* ───────────── 4. second PO, same items ───────────── */
  section('4. A prepared file on another PO with the same items');
  const P2 = await po([[A, 20, 110], [B, 5, 200], [BT, 4, 55]]);
  const f2 = await fill(x1.buffer, { head: goodHead(2), rows: { [CODE.BT]: { batch: heat.code } } });  // P1's file, now adding to the batch
  const d2 = await imp1(P2.id, f2, true);
  ok('it applies — no refusal', d2.ok === true, JSON.stringify(d2.problems));
  ok('note: file made for PO1, applying to PO2', d2.notes.some((n) => n === `File made for ${P1.code}, applying to ${P2.code}.`), JSON.stringify(d2.notes));
  ok('matched to P2\'s lines by item code', same(d2.changes.map((x) => x.lineId), P2.lines));
  ok('the file\'s own price (100) is what is booked, not P2\'s 110', d2.changes[0].unitPrice === 100);
  const a2 = await imp1(P2.id, f2, false);
  ok('booked', a2.applied === true && a2.bill.lineCount === 3, JSON.stringify(a2.problems));
  ok('partial on A: 10 of 20', (await received(P2.lines[0])) === 10);
  ok('P2 is part received', (await poStatus(P2.id)) === 'partially_received');
  const [[bl]] = await db.query('SELECT k.batch_id FROM cf_stock_ledger k WHERE k.movement_id = ? LIMIT 1', [a2.movements[2].id]);
  ok('"Add to batch" put BT into the existing batch', Number(bl?.batch_id) === Number(heat.id));

  /* ───────────── 5. partial receipt ───────────── */
  section('5. Partial receipt');
  const P3 = await po([[A, 10, 100], [B, 5, 200]]);
  const x3 = await SHEET.exportGrnSheet(db, COMPANY, P3.id);
  const f3 = await fill(x3.buffer, { head: { ...goodHead(3), invoiceNo: '', invoiceDate: '', toFollow: 'Yes', freight: '', freightGst: '' }, rows: { [CODE.A]: { qty: 4 }, [CODE.B]: { qty: 0 } } });
  const a3 = await imp1(P3.id, f3, false);
  ok('booked with "invoice to follow" and no invoice', a3.applied === true && a3.bill.invoice.pending === true, JSON.stringify(a3.problems));
  ok('only A, 4 of 10', a3.changes.length === 1 && a3.changes[0].quantity === 4 && (await received(P3.lines[0])) === 4 && (await received(P3.lines[1])) === 0);
  ok('the 0 row is said to be left out', a3.notes.some((n) => /1 row with a Receive qty of 0 or blank left out/.test(n)), JSON.stringify(a3.notes));
  const s3 = await readBack((await SHEET.exportGrnSheet(db, COMPANY, P3.id)).buffer);
  ok('the next download has A pending 6 and B pending 5', s3.rows.length === 2 && s3.rows[0].pending === 6 && s3.rows[0].qty === 6 && s3.rows[1].pending === 5);
  const f3b = await fill(x3.buffer, { head: goodHead(4), rows: { [CODE.A]: { qty: '' }, [CODE.B]: { qty: '' } } });
  const d3b = await imp1(P3.id, f3b, true);
  ok('all rows blank → "nothing to receive"', d3b.ok === false && d3b.problems.some((p) => /nothing to receive/.test(p)));

  /* ───────────── 6. refusals ───────────── */
  section('6. Refusals — every one at once, nothing written');
  const P4 = await po([[A, 10, 100], [B, 5, 200], [BT, 4, 50]]);
  const x4 = await SHEET.exportGrnSheet(db, COMPANY, P4.id);
  const c4 = await counts();
  const f4 = await fill(x4.buffer, {
    head: { store: DS, invoiceNo: '', invoiceDate: '', toFollow: 'No' },
    rows: { [CODE.A]: { qty: 11 }, [CODE.BT]: { lot: '' }, [`+${RUN}-NOPE`]: { qty: 2 } },
  });
  const d4 = await imp1(P4.id, f4, false);   // a NON-dry run that is refused
  const has = (re) => d4.problems.some((p) => re.test(p));
  ok('refused, not applied', d4.ok === false && d4.applied === false);
  ok('more than pending', has(new RegExp(`${CODE.A}: 11 nos to receive, but only 10 is pending`)), JSON.stringify(d4.problems));
  ok('an item not on the PO', has(new RegExp(`${RUN}-NOPE is not on ${P4.code}`)));
  ok('a dispatch area is not a store', has(/is a dispatch area/));
  ok('a batch item without a lot or batch code', has(new RegExp(`${CODE.BT} is kept by batch`)));
  ok('the sentence counts the problems', /problems — nothing booked/.test(d4.summary.sentence));
  ok('nothing written by the refused upload', same(c4, await counts()));
  const f4b = await fill(x4.buffer, { head: { store: 'NO-SUCH-STORE', invoiceNo: '', invoiceDate: '', toFollow: 'maybe' }, rows: { [CODE.BT]: { batch: 'NO-SUCH-BATCH' } } });
  const d4b = await imp1(P4.id, f4b, true);
  ok('an unknown store code', d4b.problems.some((p) => /no stocking area with code "NO-SUCH-STORE"/.test(p)), JSON.stringify(d4b.problems));
  ok('invoice to follow must be Yes or No', d4b.problems.some((p) => /Yes or No/.test(p)));
  ok('an unknown batch code', d4b.problems.some((p) => /no batch "NO-SUCH-BATCH"/.test(p)));
  const f4c = await fill(x4.buffer, { head: { store: ST, invoiceNo: '', invoiceDate: '', toFollow: 'No' }, rows: { [CODE.BT]: { lot: 'L1' } } });
  const d4c = await imp1(P4.id, f4c, true);
  ok('the GRN\'s own check: invoice no. and date, or to follow', d4c.problems.some((p) => /supplier invoice number/.test(p)) && d4c.problems.some((p) => /supplier invoice date/.test(p)), JSON.stringify(d4c.problems));
  const P5 = await po([[A, 10, 100]], 'draft');
  const f5 = await fill((await SHEET.exportGrnSheet(db, COMPANY, P5.id)).buffer, { head: goodHead(5) });
  const d5 = await imp1(P5.id, f5, true);
  ok('a PO not yet ordered — found by the booking inside the savepoint, in the dry run', d5.ok === false && d5.problems.some((p) => /not been placed|waiting for Management/.test(p)), JSON.stringify(d5.problems));
  ok('…and nothing written', same(c4, await counts()));
  let refusedDl = null;
  try { await SHEET.exportGrnSheet(db, COMPANY, P1.id); } catch (e) { refusedDl = e; }
  ok('no sheet for a PO with nothing pending', !!refusedDl && /Nothing is pending/.test(refusedDl.message));
  let bad = null;
  try { await imp1(P4.id, Buffer.from('not a workbook').toString('base64'), true); } catch (e) { bad = e; }
  ok('a file that is not a workbook is refused in words', !!bad && /could not be opened as an Excel workbook/.test(bad.message));

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
