/**
 * buying_sheets_test.mjs — THE BUYING CHAIN AS EXCEL (services/buyingSheetService.js, routes/buyingSheets.js; 2026-10-31):
 *
 *   cd multi_app_be && node scripts/cf_kepl/buying_sheets_test.mjs        CF_BUYSHEET_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-BXL-<run>).
 *
 *   1  MATERIAL REQUEST: download (banner, headers, grey / white) → change take from stock → dry run writes nothing →
 *      apply = saveMr (holds, the PR); refusals in words (more than free stock, unknown item, item not on the MR, not a
 *      number) all at once; a real upload with problems is a 422; the SAME sheet onto a second MR with the same items
 *   2  PURCHASE REQUEST quotes: wide (vendor columns by supplier code) — a new supplier code adds the vendor, "-" clears,
 *      empty leaves as is; long format (item code × supplier code); refusals (unknown supplier, a customer, bad rate,
 *      item not on the PR); dry run writes nothing; the sheet of one PR onto another with the same items
 *   3  PURCHASE ORDER: download (facts + lines) → qty / unit price / line date / the PO's own date → dry run writes
 *      nothing → apply; refusals; onto a second PO with the same items; once approved: refused ("changing an approved PO")
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const ExcelJS = (await import('exceljs')).default;
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PRS = await imp('apps/cf_erp/services/purchaseRequestService.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const BX = await imp('apps/cf_erp/services/buyingSheetService.js');
const { harness, simple, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_BUYSHEET_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-BXL-${RUN}`;
const H = harness(pool);
const { ok, section, refusal, j } = H;
const before = await H.counts();
const db = await pool.getConnection();
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

/** The workbook of a download, to read and change. */
const open = async (out) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.buffer); return wb; };
const b64 = async (wb) => Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
const textOf = (v) => (v == null ? '' : typeof v === 'object' && 'richText' in v ? v.richText.map((r) => r.text).join('') : String(v));
/** Column number of a header text on row `headRow`. */
const colIn = (ws, headRow, text) => { let at = 0; ws.getRow(headRow).eachCell((c, i) => { if (textOf(c.value).trim().toLowerCase() === text.toLowerCase()) at = i; }); return at; };
/** Sheet row of an item code (column 1) below `headRow`. */
const rowOf = (ws, headRow, code) => { let at = 0; ws.eachRow((r, n) => { if (n > headRow && textOf(r.getCell(1).value) === code) at = n; }); return at; };
const grey = (cell) => cell.fill?.fgColor?.argb === 'FFEFEFEF';
/** A brand-new sheet from rows of values (a sheet "prepared by hand"). */
const handMade = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Mine'); for (const r of rows) ws.addRow(r); return b64(wb); };

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  await quietCodes(db, COMPANY);
  const S = await simple(db, c, tag, { itemKeys: ['A', 'B', 'C'] });
  const { A, B, C } = S.items;
  const codeA = `${tag}-A`; const codeB = `${tag}-B`; const codeC = `${tag}-C`;
  const sup1 = `${tag}-S1`; const sup2 = `${tag}-S2`; const cus = `${tag}-CUS`;
  const gl = (s, item) => s.lines.find((l) => Number(l.item.id) === Number(item));
  const prl = (p, item) => p.lines.find((l) => Number(l.item.id) === Number(item));
  const col = (p, supId) => p.vendors.find((v) => Number(v.supplier.id) === Number(supId));
  /** Everything an upload could write, read inside the transaction. */
  const snap = async () => JSON.stringify((await db.query(
    `SELECT (SELECT COUNT(*) FROM cf_stock_reservations WHERE company_id = ?) r,
            (SELECT COALESCE(SUM(quantity), 0) FROM cf_stock_reservations WHERE company_id = ? AND status = 'active') rq,
            (SELECT COALESCE(SUM(stock_take), -1) FROM cf_requisition_lines WHERE company_id = ? AND item_id IN (?)) st,
            (SELECT COUNT(*) FROM cf_buy_requests WHERE company_id = ?) br,
            (SELECT COALESCE(SUM(quantity), 0) FROM cf_buy_request_lines WHERE company_id = ? AND item_id IN (?)) bl,
            (SELECT COUNT(*) FROM cf_buy_request_vendors WHERE company_id = ? AND deleted_at IS NULL) bv,
            (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(rate), 0), '/', COALESCE(SUM(delivery_days), 0), '/', COALESCE(GROUP_CONCAT(remark), '')) FROM cf_buy_request_quotes WHERE company_id = ? AND deleted_at IS NULL) bq,
            (SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(quantity), 0), '/', COALESCE(SUM(unit_price), 0), '/', COALESCE(GROUP_CONCAT(expected_date), '')) FROM cf_purchase_order_lines WHERE company_id = ? AND item_id IN (?) AND deleted_at IS NULL) pl,
            (SELECT COALESCE(GROUP_CONCAT(expected_date), '') FROM cf_purchase_orders WHERE company_id = ? AND id IN (SELECT purchase_order_id FROM cf_purchase_order_lines WHERE item_id IN (?))) pd,
            (SELECT COUNT(*) FROM cf_purchase_date_changes WHERE company_id = ?) dc`,
    [COMPANY, COMPANY, COMPANY, [A, B, C], COMPANY, COMPANY, [A, B, C], COMPANY, COMPANY, COMPANY, [A, B, C], COMPANY, [A, B, C], COMPANY],
  ))[0][0]);

  /* ════════════════════ 1. MATERIAL REQUEST ════════════════════ */
  section('1. MATERIAL REQUEST — take from stock by item code');
  await S.receive(A, 10);
  await S.receive(B, 2);
  const G1 = await RQ.createRequisition(db, c, { forType: 'general', note: `${tag} one`, lines: [{ itemId: A, qty: 6 }, { itemId: B, qty: 4 }] });
  const G2 = await RQ.createRequisition(db, c, { forType: 'general', note: `${tag} two`, lines: [{ itemId: A, qty: 4 }, { itemId: B, qty: 3 }] });
  let s1 = await PRS.mrScreen(db, COMPANY, G1.id);
  const mrOut = await BX.exportMrSheet(db, COMPANY, G1.id);
  let wb = await open(mrOut);
  let ws = wb.worksheets[0];
  ok('download: a .xlsx named by the MR, one row per line', mrOut.filename === `${s1.code}.xlsx` && mrOut.rows === 2 && mrOut.contentType.includes('spreadsheetml'), j([mrOut.filename, mrOut.rows]));
  ok('row 1 says how to fill it; row 2 is the header row', textOf(ws.getCell(1, 1).value) === BX.MR_BANNER
    && ['Item code', 'Name', 'UOM', 'Required', 'In stock (free)', 'Take from stock', 'To buy', 'Issued'].every((h, i) => textOf(ws.getCell(2, i + 1).value) === h), j(ws.getRow(2).values));
  const takeCol = colIn(ws, 2, 'Take from stock');
  const rA = rowOf(ws, 2, codeA); const rB = rowOf(ws, 2, codeB);
  ok('rows by item code: required, in stock (free) as the screen', near(ws.getCell(rA, 4).value, 6) && near(ws.getCell(rA, 5).value, 10) && near(ws.getCell(rB, 4).value, 4) && near(ws.getCell(rB, 5).value, 2), j([ws.getRow(rA).values, ws.getRow(rB).values]));
  ok('take from stock is white (typed); required / to buy are grey', !grey(ws.getCell(rA, takeCol)) && grey(ws.getCell(rA, 4)) && grey(ws.getCell(rA, 7)), '');
  ok('take from stock shows what the screen pre-fills (the proposal, nothing chosen yet)', near(ws.getCell(rA, takeCol).value, gl(s1, A).proposedTake) && near(ws.getCell(rB, takeCol).value, gl(s1, B).proposedTake), j([ws.getCell(rA, takeCol).value, gl(s1, A).proposedTake]));

  ws.getCell(rA, takeCol).value = 5;
  ws.getCell(rB, takeCol).value = 2;
  const mrFile = await b64(wb);
  let pre = await snap();
  const dry = await BX.importMrSheet(db, c, G1.id, { fileBase64: mrFile, dryRun: true });
  ok('dry run: ok, two changes, a sentence', dry.ok && dry.dryRun && dry.changes.length === 2 && /2 lines/.test(dry.summary.sentence), j(dry));
  ok('dry run writes nothing (holds, takes, PR all as before)', (await snap()) === pre, '');
  const applied = await BX.importMrSheet(db, c, G1.id, { fileBase64: mrFile });
  s1 = await PRS.mrScreen(db, COMPANY, G1.id);
  ok('apply: take from stock 5 and 2 — saved as the screen saves (held from stock)', applied.applied === true && near(gl(s1, A).takeFromStock, 5) && near(gl(s1, B).takeFromStock, 2) && near(gl(s1, A).heldFromStock, 5) && near(gl(s1, B).heldFromStock, 2), j(s1.lines.map((l) => [l.takeFromStock, l.heldFromStock])));
  let pr1 = (await PRS.readPrs(db, COMPANY, { requisitionIds: [G1.id] }))[0];
  ok('…and the rest is on the PR (A 1, B 2)', !!pr1 && near(prl(pr1, A).needed, 1) && near(prl(pr1, B).needed, 2), j(pr1?.lines.map((l) => [l.item.code, l.needed])));
  const again = await BX.importMrSheet(db, c, G1.id, { fileBase64: mrFile, dryRun: true });
  ok('the same file again: nothing to change', again.ok && again.changes.length === 0 && again.summary.sentence === 'nothing to change', j(again.summary));

  // refusals, every one at once
  wb = await open(await BX.exportMrSheet(db, COMPANY, G1.id));
  ws = wb.worksheets[0];
  ws.getCell(rowOf(ws, 2, codeB), takeCol).value = 4;      // B: only 0 more free
  ws.getCell(rowOf(ws, 2, codeA), takeCol).value = 'lots';
  ws.addRow(['NO-SUCH-ITEM-XYZ', '', '', '', '', 1]);
  ws.addRow([codeC, '', '', '', '', 1]);
  const badMr = await BX.importMrSheet(db, c, G1.id, { fileBase64: await b64(wb), dryRun: true });
  const ps = badMr.problems.join(' | ');
  ok('refused in words: not a number, unknown item, item not on the MR', !badMr.ok && /lots/.test(ps) && /no item has the code "NO-SUCH-ITEM-XYZ"/.test(ps) && ps.includes(`${codeC} is not on ${s1.code}`), ps);
  wb = await open(await BX.exportMrSheet(db, COMPANY, G1.id));
  ws = wb.worksheets[0];
  ws.getCell(rowOf(ws, 2, codeB), takeCol).value = 4;
  const moreThanFree = await BX.importMrSheet(db, c, G1.id, { fileBase64: await b64(wb), dryRun: true });
  ok('more than free stock: saveMr\'s own refusal, as a problem of the preview', !moreThanFree.ok && moreThanFree.problems.some((p) => /free in stock/.test(p) && p.includes(codeB)), j(moreThanFree.problems));
  pre = await snap();
  const tooMuch = await b64(wb);
  const thrown = await refusal(() => BX.importMrSheet(db, c, G1.id, { fileBase64: tooMuch }));
  ok('a real upload with problems is a 422 with every problem, and writes nothing', thrown?.status === 422 && Array.isArray(thrown.problems) && thrown.problems.length >= 1 && (await snap()) === pre, j([thrown?.status, thrown?.problems]));
  const notXlsx = await refusal(() => BX.importMrSheet(db, c, G1.id, { fileBase64: Buffer.from('hello').toString('base64'), dryRun: true }));
  ok('not an Excel file: refused in words', notXlsx?.code === 'BAD_FILE', j(notXlsx?.message));

  // the same sheet onto another MR with the same items: matched by item code
  const onG2 = await openAndSet(mrFile, takeCol, { [codeA]: 2, [codeB]: 0 });
  const g2r = await BX.importMrSheet(db, c, G2.id, { fileBase64: onG2 });
  const s2 = await PRS.mrScreen(db, COMPANY, G2.id);
  ok('business keys: G1\'s sheet onto G2 (same items) sets G2\'s take by item code', g2r.applied === true && near(gl(s2, A).takeFromStock, 2) && near(gl(s2, B).takeFromStock, 0), j(s2.lines.map((l) => [l.item.code, l.takeFromStock])));
  const hand = await handMade([['my own list'], ['Item code', 'Take from stock'], [codeA.toLowerCase(), 3]]);
  const g2h = await BX.importMrSheet(db, c, G2.id, { fileBase64: hand });
  ok('a sheet prepared by hand (two columns, item code in any case) reads back', g2h.applied === true && near(gl(await PRS.mrScreen(db, COMPANY, G2.id), A).takeFromStock, 3), j(g2h));
  const pr2 = (await PRS.readPrs(db, COMPANY, { requisitionIds: [G2.id] }))[0];

  /* ════════════════════ 2. PURCHASE REQUEST ════════════════════ */
  section('2. PURCHASE REQUEST — the quote grid by item code × supplier code');
  pr1 = await PRS.addVendor(db, c, pr1.id, { supplierId: S.S1 });
  pr1 = await PRS.setQuotes(db, c, col(pr1, S.S1).id, { quotes: [{ lineId: prl(pr1, A).id, rate: 30, deliveryDays: 4, remark: 'old' }] });
  const prOut = await BX.exportPrSheet(db, COMPANY, pr1.id);
  wb = await open(prOut);
  ws = wb.worksheets[0];
  ok('download: banner, then Item code / Name / UOM / Needed / To order and three columns per vendor headed by its code',
    textOf(ws.getCell(1, 1).value) === BX.PR_BANNER && colIn(ws, 2, 'Item code') === 1 && colIn(ws, 2, 'Needed') > 0 && colIn(ws, 2, 'To order') > 0
    && colIn(ws, 2, `${sup1} rate`) > 0 && colIn(ws, 2, `${sup1} days`) > 0 && colIn(ws, 2, `${sup1} remark`) > 0, j(ws.getRow(2).values));
  const r1 = colIn(ws, 2, `${sup1} rate`);
  ok('the quote is in its cells (white); needed is grey', near(ws.getCell(rowOf(ws, 2, codeA), r1).value, 30) && ws.getCell(rowOf(ws, 2, codeA), r1 + 1).value === 4 && !grey(ws.getCell(rowOf(ws, 2, codeA), r1)) && grey(ws.getCell(rowOf(ws, 2, codeA), 4)), '');
  // S1: clear A ("-"), quote B; a new vendor S2 by its code
  ws.getCell(rowOf(ws, 2, codeA), r1).value = '-';
  ws.getCell(rowOf(ws, 2, codeB), r1).value = 50;
  ws.getCell(rowOf(ws, 2, codeB), r1 + 1).value = 7;
  const n2 = ws.getRow(2).cellCount + 1;
  ws.getCell(2, n2).value = `${sup2} rate`; ws.getCell(2, n2 + 1).value = `${sup2} days`; ws.getCell(2, n2 + 2).value = `${sup2} remark`;
  ws.getCell(rowOf(ws, 2, codeA), n2).value = 40; ws.getCell(rowOf(ws, 2, codeA), n2 + 1).value = 5; ws.getCell(rowOf(ws, 2, codeA), n2 + 2).value = 'ex works';
  const prFile = await b64(wb);
  pre = await snap();
  const prDry = await BX.importPrSheet(db, c, pr1.id, { fileBase64: prFile, dryRun: true });
  ok('dry run: a vendor added, three quotes changed', prDry.ok && prDry.summary.vendorsAdded === 1 && prDry.summary.quotesChanged === 3 && /1 vendor added, 3 quotes changed/.test(prDry.summary.sentence), j(prDry));
  ok('dry run writes nothing (no vendor column, quotes as before)', (await snap()) === pre, '');
  const prApplied = await BX.importPrSheet(db, c, pr1.id, { fileBase64: prFile });
  pr1 = await PRS.getPr(db, COMPANY, pr1.id);
  const q = (p, sup, item) => col(p, sup)?.quotes[prl(p, item).id] ?? null;
  ok('apply: S2 is a vendor column now', prApplied.applied === true && pr1.vendors.length === 2 && !!col(pr1, S.S2), j(pr1.vendors.map((v) => v.supplier.code)));
  ok('"-" cleared S1\'s quote for A; S1 quotes B 50 / 7 d', q(pr1, S.S1, A) === null && near(q(pr1, S.S1, B)?.rate, 50) && q(pr1, S.S1, B)?.deliveryDays === 7, j(col(pr1, S.S1).quotes));
  ok('S2 quotes A 40 / 5 d / "ex works"', near(q(pr1, S.S2, A)?.rate, 40) && q(pr1, S.S2, A)?.deliveryDays === 5 && q(pr1, S.S2, A)?.remark === 'ex works', j(col(pr1, S.S2).quotes));
  // empty = as it is: a remark only
  const remarkOnly = await handMade([['x'], ['Item code', `${sup1} rate`, `${sup1} days`, `${sup1} remark`], [codeB, '', '', 'urgent']]);
  await BX.importPrSheet(db, c, pr1.id, { fileBase64: remarkOnly });
  pr1 = await PRS.getPr(db, COMPANY, pr1.id);
  ok('an empty cell leaves the value as it is (only the remark changed)', near(q(pr1, S.S1, B)?.rate, 50) && q(pr1, S.S1, B)?.deliveryDays === 7 && q(pr1, S.S1, B)?.remark === 'urgent', j(q(pr1, S.S1, B)));
  // long format
  const long = await handMade([['long'], ['Item code', 'Supplier code', 'Rate', 'Delivery days', 'Remark'], [codeA, sup1, 45, 3, ''], [codeB, sup2, '42.5', '', 'ok']]);
  const longR = await BX.importPrSheet(db, c, pr1.id, { fileBase64: long });
  pr1 = await PRS.getPr(db, COMPANY, pr1.id);
  ok('long format (item code × supplier code): told apart by its header', longR.applied === true && longR.format === 'long' && near(q(pr1, S.S1, A)?.rate, 45) && q(pr1, S.S1, A)?.deliveryDays === 3 && near(q(pr1, S.S2, B)?.rate, 42.5) && q(pr1, S.S2, B)?.remark === 'ok', j([q(pr1, S.S1, A), q(pr1, S.S2, B)]));
  const days0 = await handMade([['x'], ['Item code', `${sup1} rate`], [codeB, 5]]);
  const lone = await BX.importPrSheet(db, c, pr1.id, { fileBase64: days0, dryRun: true });
  ok('a rate-only column is enough', lone.ok && lone.summary.quotesChanged === 1, j(lone));
  // refusals
  const badPr = await handMade([['x'], ['Item code', 'Supplier code', 'Rate', 'Delivery days'],
    [codeA, 'NO-SUCH-SUP', 10, 1], [codeA, cus, 10, 1], [codeB, sup1, 'cheap', 1], [codeA, sup2, 10, 2.5], [codeC, sup1, 10, 1], ['', sup1, 1, 1], [codeB, sup2, '', 4]]);
  pre = await snap();
  const prBad = await BX.importPrSheet(db, c, pr1.id, { fileBase64: badPr, dryRun: true });
  const pp = prBad.problems.join(' | ');
  ok('refused, all at once: unknown supplier, a customer, bad rate, bad days, item not on the PR, no item code',
    !prBad.ok && /"NO-SUCH-SUP": no party/.test(pp) && /not marked as a supplier/.test(pp) && /cheap/.test(pp) && /whole number/.test(pp) && pp.includes(`${codeC} is not on ${pr1.code}`) && /no item code/.test(pp), pp);
  ok('…and nothing written', (await snap()) === pre, '');
  const needRate = await handMade([['x'], ['Item code', 'Supplier code', 'Rate', 'Delivery days'], [codeA, sup1, '-', ''], [codeB, sup2, '', '']]);
  const nr = await BX.importPrSheet(db, c, pr1.id, { fileBase64: needRate, dryRun: true });
  ok('long: "-" in the rate clears the quote', nr.ok && nr.changes.some((x) => x.action === 'remove' && x.path === `${codeA} / ${sup1}`), j(nr));
  const days4 = await handMade([['x'], ['Item code', 'Supplier code', 'Rate', 'Delivery days'], [codeC, sup2, '', 4]]);
  ok('a row of an item not on the PR is refused (not skipped)', !(await BX.importPrSheet(db, c, pr1.id, { fileBase64: days4, dryRun: true })).ok, '');
  // the PR1 sheet onto PR2 (same items): vendors by supplier code, rows by item code
  const pr1Sheet = await b64(await open(await BX.exportPrSheet(db, COMPANY, pr1.id)));
  const onPr2 = await BX.importPrSheet(db, c, pr2.id, { fileBase64: pr1Sheet });
  const pr2Now = await PRS.getPr(db, COMPANY, pr2.id);
  ok('business keys: PR1\'s sheet onto PR2 adds S1 and S2 and copies their quotes by item code', onPr2.applied === true && pr2Now.vendors.length === 2
    && near(q(pr2Now, S.S1, A)?.rate, 45) && near(q(pr2Now, S.S1, B)?.rate, 50) && near(q(pr2Now, S.S2, A)?.rate, 40) && near(q(pr2Now, S.S2, B)?.rate, 42.5), j(pr2Now.vendors.map((v) => [v.supplier.code, v.quotes])));

  /* ════════════════════ 3. PURCHASE ORDER ════════════════════ */
  section('3. PURCHASE ORDER — qty, unit price, expected date by item code');
  const raised = await PRS.raisePo(db, c, col(pr1, S.S1).id, { lines: [{ lineId: prl(pr1, A).id, quantity: 1 }, { lineId: prl(pr1, B).id, quantity: 2 }] });
  const po1 = raised.purchaseOrder;
  const poOut = await BX.exportPoSheet(db, COMPANY, po1.id);
  wb = await open(poOut);
  ws = wb.worksheets[0];
  const facts = [2, 3, 4, 5].map((n) => textOf(ws.getCell(n, 1).value));
  const head = 7;
  ok('download: banner, the facts (PO no., supplier, status, expected date), then the line headers', textOf(ws.getCell(1, 1).value) === BX.PO_BANNER
    && j(facts) === j(['PO no.', 'Supplier', 'Status', 'Expected date']) && textOf(ws.getCell(2, 2).value) === po1.code
    && ['Item code', 'Name', 'UOM', 'Qty', 'Received', 'Pending', 'Unit price', 'GST rate %', 'Amount', 'Expected date'].every((h, i) => textOf(ws.getCell(head, i + 1).value) === h), j([facts, ws.getRow(head).values]));
  const pA = rowOf(ws, head, codeA); const pB = rowOf(ws, head, codeB);
  ok('lines: qty and price as on the PO; qty / price / date white, received grey', near(ws.getCell(pA, 4).value, 1) && near(ws.getCell(pB, 7).value, 50) && !grey(ws.getCell(pA, 4)) && !grey(ws.getCell(pA, 7)) && !grey(ws.getCell(pA, 10)) && grey(ws.getCell(pA, 5)), j([ws.getRow(pA).values, ws.getRow(pB).values]));
  ws.getCell(pA, 4).value = 1.5;
  ws.getCell(pB, 7).value = 55;
  ws.getCell(pA, 10).value = new Date(Date.UTC(2026, 10, 20));
  ws.getCell(pB, 10).value = '21-11-2026';
  ws.getCell(5, 2).value = '2026-11-25';
  const poFile = await b64(wb);
  pre = await snap();
  const poDry = await BX.importPoSheet(db, c, po1.id, { fileBase64: poFile, dryRun: true });
  ok('dry run: two lines and the PO\'s date', poDry.ok && poDry.summary.linesChanged === 2 && poDry.summary.headerChanged === 1 && poDry.changes.length === 5, j(poDry));
  ok('dry run writes nothing', (await snap()) === pre, '');
  const poApplied = await BX.importPoSheet(db, c, po1.id, { fileBase64: poFile });
  let po = await PS.getPurchaseOrder(db, COMPANY, po1.id);
  const pl = (p, item) => p.lines.find((l) => Number(l.item.id) === Number(item));
  const iso = (d) => (d == null ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
  ok('apply: A qty 1.5, B price 55, line dates 2026-11-20 / 2026-11-21 (DD-MM-YYYY read), PO date 2026-11-25',
    poApplied.applied === true && near(pl(po, A).quantity, 1.5) && near(pl(po, B).unitPrice, 55) && iso(pl(po, A).expectedDate) === '2026-11-20' && iso(pl(po, B).expectedDate) === '2026-11-21' && iso(po.expectedDate) === '2026-11-25',
    j([pl(po, A).quantity, pl(po, B).unitPrice, pl(po, A).expectedDate, pl(po, B).expectedDate, po.expectedDate]));
  ok('…and the date changes are recorded as the screen records them', po.dateChanges.length >= 3, j(po.dateChanges));
  const clearPrice = await handMade([['x'], ['Item code', 'Unit price', 'Expected date'], [codeB, '-', '-']]);
  await BX.importPoSheet(db, c, po1.id, { fileBase64: clearPrice });
  po = await PS.getPurchaseOrder(db, COMPANY, po1.id);
  ok('"-" clears a price and a date', pl(po, B).unitPrice == null && pl(po, B).expectedDate == null, j(pl(po, B)));
  const badPo = await handMade([['x'], ['Item code', 'Qty', 'Unit price', 'Expected date'], [codeA, 0, '', ''], [codeB, '', -3, '31-02-2026'], [codeC, 1, '', ''], [codeA, 2, '', '']]);
  pre = await snap();
  const poBad = await BX.importPoSheet(db, c, po1.id, { fileBase64: badPo, dryRun: true });
  const bp = poBad.problems.join(' | ');
  ok('refused, all at once: qty 0, negative price, not a date, item not on the PO, an item twice', !poBad.ok && /above zero/.test(bp) && /zero or more/.test(bp) && /31-02-2026/.test(bp) && bp.includes(`${codeC} is not on ${po1.code}`) && /also on row/.test(bp), bp);
  ok('…nothing written', (await snap()) === pre, '');
  // onto another PO with the same items
  const raised2 = await PRS.raisePo(db, c, col(pr2Now, S.S1).id, { lines: [{ lineId: prl(pr2Now, A).id, quantity: 1 }, { lineId: prl(pr2Now, B).id, quantity: 1 }] });
  const onPo2 = await BX.importPoSheet(db, c, raised2.purchaseOrder.id, { fileBase64: poFile });
  const po2 = await PS.getPurchaseOrder(db, COMPANY, raised2.purchaseOrder.id);
  ok('business keys: PO1\'s sheet onto PO2 (same items) by item code', onPo2.applied === true && near(pl(po2, A).quantity, 1.5) && near(pl(po2, B).unitPrice, 55) && iso(po2.expectedDate) === '2026-11-25', j(po2.lines.map((l) => [l.item.code, l.quantity, l.unitPrice])));
  // approved: refused
  await PS.approvePurchaseOrder(db, c, po1.id, {});
  const late = await refusal(() => BX.importPoSheet(db, c, po1.id, { fileBase64: poFile, dryRun: true }));
  ok('once approved: refused in words ("changing an approved PO …")', late?.status === 409 && late.code === 'APPROVED' && /changing an approved PO/.test(late.message), j([late?.code, late?.message]));
  const dl = await BX.exportPoSheet(db, COMPANY, po1.id);
  const wsA = (await open(dl)).worksheets[0];
  ok('…and its download has no white cells to type in', grey(wsA.getCell(rowOf(wsA, head, codeA), 4)) && grey(wsA.getCell(5, 2)), '');
} finally {
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

/** A downloaded MR sheet with some takes set (by item code). */
async function openAndSet(base64, takeColumn, takes) {
  const w = new ExcelJS.Workbook();
  await w.xlsx.load(Buffer.from(base64, 'base64'));
  const s = w.worksheets[0];
  s.eachRow((r, n) => { if (n > 2 && Object.hasOwn(takes, textOf(r.getCell(1).value))) r.getCell(takeColumn).value = takes[textOf(r.getCell(1).value)]; });
  return b64(w);
}

const after = await H.counts();
const changed = after.filter((a) => (before.find((b) => b.name === a.name)?.n ?? 0) !== a.n).map((a) => a.name);
ok('ROLLED BACK: every cf_ table has exactly the rows it had', changed.length === 0, changed.join(', '));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed`);
if (H.state.failed) { console.log(H.state.fails.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1; }
await pool.end();
