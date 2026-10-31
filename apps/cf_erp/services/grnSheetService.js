/**
 * grnSheetService.js — "Receive against PO" as a spreadsheet, out and back in (user, 2026-10-31: "We need excel for …
 * Receive PO"; they demo with PREPARED files, so a sheet must apply to ANY purchase order holding the same items).
 *
 * DOWNLOAD (GET /purchase-orders/:id/grn-sheet) — one sheet, "GRN":
 *   row 1           one sentence on how to fill it
 *   header block    label in A, value in B, found again by its LABEL (never by row number):
 *                     PO no. (grey, read-only) · Supplier (grey) · Store code (white; the store most purchases land in) ·
 *                     Delivery note · Supplier invoice no. · Invoice date (YYYY-MM-DD) · Invoice to follow (Yes/No) ·
 *                     Freight ₹ · Freight GST % · Other charges ₹ · Other charges GST %  (a blank GST % = no GST on it)
 *   lines table     under a row whose A cell is "Item code"; columns found by their header text:
 *                     Item code · Item name · UoM · Pending (grey) · Receive qty (white, = pending) · Unit price (the PO's) ·
 *                     HSN / SAC · GST % · Heat / supplier lot no. · Add to batch (an existing batch code; batch items only)
 *
 * UPLOAD (POST /purchase-orders/:id/grn-sheet { fileBase64, dryRun }) — matched by BUSINESS KEYS, no hidden ids:
 *   a row       -> the PO's pending line(s) of that ITEM CODE; one item on two lines is filled in line order (and said so)
 *   Receive 0 / blank -> the row is left out
 *   Store code  -> an active receiving area of that code
 *   PO no. on the sheet that is not this PO -> a NOTE ("file made for PO-x, applying to PO-y"), never a refusal
 * Every problem at once: the sheet's own (unknown item, more than pending, store, batch lot / batch code …), then the
 * GRN's own checks (grnService.receiveGrn — the dialog's save). The dry run books the GRN for real inside a SAVEPOINT
 * and rolls it back, so the preview has caught everything the real booking would refuse (store kind, the batch's own
 * required values, PO not yet approved …) and writes nothing. Only a non-dry run keeps the ONE GRN it books.
 * Needs a transaction (the route's).
 */
import ExcelJS from 'exceljs';
import { CfError, invalid } from '../lib/errors.js';
import { getPurchaseOrder } from './purchaseService.js';
import { grnContext, receiveGrn } from './grnService.js';
import { RECEIVING_PURPOSES } from './stockingAreaService.js';

export const SHEET_NAME = 'GRN';
export const BANNER = 'Grey cells are from the purchase order — fill the white ones. A row is matched to the PO by its item code; a Receive qty of 0 or blank leaves the row out.';

export const HEAD = {
  po: 'PO no.',
  supplier: 'Supplier',
  store: 'Store code',
  reference: 'Delivery note',
  invoiceNo: 'Supplier invoice no.',
  invoiceDate: 'Invoice date (YYYY-MM-DD)',
  toFollow: 'Invoice to follow (Yes/No)',
  freight: 'Freight ₹',
  freightGst: 'Freight GST % (blank = none)',
  other: 'Other charges ₹',
  otherGst: 'Other charges GST % (blank = none)',
};
export const COL = {
  code: 'Item code', name: 'Item name', uom: 'UoM', pending: 'Pending', qty: 'Receive qty', price: 'Unit price ₹',
  hsn: 'HSN / SAC', gst: 'GST %', lot: 'Heat / supplier lot no.', batch: 'Add to batch (batch code)',
};
const COL_ORDER = ['code', 'name', 'uom', 'pending', 'qty', 'price', 'hsn', 'gst', 'lot', 'batch'];
const COL_WIDTH = { code: 26, name: 36, uom: 8, pending: 11, qty: 12, price: 13, hsn: 12, gst: 8, lot: 24, batch: 24 };
const WHITE_COLS = new Set(['qty', 'price', 'hsn', 'gst', 'lot', 'batch']);

const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const GREY_HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const EDGE = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };
const EPS = 1e-6;
const MAX_ROWS = 5000;

const blank = (v) => v == null || String(v).trim() === '';
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const fmt = (n) => String(round6(n));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pad = (n) => String(n).padStart(2, '0');

/** One ExcelJS cell as plain text (formulas, rich text, dates flattened; a date as YYYY-MM-DD). */
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    return '';
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v).trim();
}

/** A typed date: YYYY-MM-DD, or DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY (how India writes it). Anything else is returned as typed. */
function dateIn(s) {
  if (blank(s)) return null;
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : t;
}
const numText = (s) => (blank(s) ? '' : String(s).replace(/,/g, '').replace(/[₹%]/g, '').trim());

/** The store purchases usually land in: the receiving area most receipts went to, else the first active store. */
async function usualStore(db, companyId) {
  const [[used]] = await db.query(
    `SELECT a.code FROM cf_stock_movements m
       JOIN cf_stock_ledger k ON k.movement_id = m.id AND k.quantity > 0
       JOIN cf_stocking_areas a ON a.id = k.stocking_area_id
      WHERE m.company_id = ? AND m.movement_type = 'receipt' AND m.purchase_line_id IS NOT NULL AND m.deleted_at IS NULL
        AND a.deleted_at IS NULL AND a.status = 'active' AND a.purpose = 'storage'
      GROUP BY a.id, a.code ORDER BY COUNT(*) DESC, a.id LIMIT 1`,
    [companyId],
  ).catch(() => [[null]]);
  if (used?.code) return used.code;
  const [[first]] = await db.query("SELECT code FROM cf_stocking_areas WHERE company_id = ? AND status = 'active' AND purpose = 'storage' AND deleted_at IS NULL ORDER BY id LIMIT 1", [companyId]);
  return first?.code ?? '';
}

/** GET /purchase-orders/:id/grn-sheet -> { buffer, filename, contentType, rows } */
export async function exportGrnSheet(db, companyId, poId) {
  const po = await getPurchaseOrder(db, companyId, poId);
  const pending = po.lines.filter((l) => l.pending > EPS);
  if (!pending.length) throw invalid('NOTHING_PENDING', `Nothing is pending on ${po.code} — there is nothing to receive.`);
  const [ctx, store] = await Promise.all([grnContext(db, companyId, po.id), usualStore(db, companyId)]);
  const tax = new Map(ctx.lines.map((l) => [Number(l.lineId), l]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', ySplit: 0 }] });
  COL_ORDER.forEach((k, i) => { ws.getColumn(i + 1).width = COL_WIDTH[k]; });
  ws.getCell('A1').value = BANNER;
  ws.getCell('A1').font = { italic: true, color: { argb: 'FF555555' } };

  const header = [
    [HEAD.po, po.code, false], [HEAD.supplier, po.supplier?.name ?? '', false], [HEAD.store, store, true],
    [HEAD.reference, '', true], [HEAD.invoiceNo, '', true], [HEAD.invoiceDate, '', true], [HEAD.toFollow, 'No', true],
    [HEAD.freight, 0, true], [HEAD.freightGst, '', true], [HEAD.other, 0, true], [HEAD.otherGst, '', true],
  ];
  let r = 3;
  for (const [label, value, white] of header) {
    const a = ws.getCell(r, 1); const b = ws.getCell(r, 2);
    a.value = label; a.font = { bold: true }; a.fill = GREY_HEAD; a.border = BOX;
    b.value = value; b.border = BOX;
    if (!white) b.fill = GREY;
    if (label === HEAD.toFollow) b.dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'] };
    if (label === HEAD.invoiceDate || label === HEAD.reference || label === HEAD.invoiceNo || label === HEAD.store) b.numFmt = '@';
    r += 1;
  }
  r += 1;
  const headRow = r;
  COL_ORDER.forEach((k, i) => {
    const cell = ws.getCell(headRow, i + 1);
    cell.value = COL[k]; cell.font = { bold: true }; cell.fill = GREY_HEAD; cell.border = BOX;
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  for (const l of pending) {
    r += 1;
    const t = tax.get(Number(l.id)) ?? {};
    const byBatch = l.item.trackedBy === 'batch';
    const values = {
      code: l.item.code ?? '', name: l.item.name ?? '', uom: l.item.uom ?? '', pending: round6(l.pending), qty: round6(l.pending),
      price: l.unitPrice ?? (t.unitPrice ?? ''), hsn: t.hsnCode ?? '', gst: t.gstRate ?? '', lot: '', batch: '',
    };
    COL_ORDER.forEach((k, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = values[k] === '' ? null : values[k];
      cell.border = BOX;
      // "Add to batch" is only for an item kept by batch; for anything else it stays grey.
      const white = WHITE_COLS.has(k) && (k !== 'batch' || byBatch) && (k !== 'lot' || byBatch);
      if (!white) cell.fill = GREY;
      if (k === 'hsn' || k === 'code' || k === 'lot' || k === 'batch') cell.numFmt = '@';
    });
  }
  ws.views = [{ state: 'frozen', ySplit: headRow }];
  const safe = String(po.code).replace(/[^A-Za-z0-9._-]+/g, '_');
  return {
    filename: `GRN_${safe}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    rows: pending.length,
  };
}

/** Reads the workbook into { head: {key: text}, rows: [{ excelRow, code, qty, … }] } or throws a readable error. */
async function readSheet(buffer, problems) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid('BAD_FILE', 'That file could not be opened as an Excel workbook (.xlsx). Download the GRN sheet and fill that.'); }
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets[0];
  if (!ws) throw invalid('BAD_FILE', 'That workbook has no sheet.');
  const labels = new Map(Object.entries(HEAD).map(([k, v]) => [norm(v), k]));
  // A label may be typed without its hint in brackets ("Invoice date") — match on the words before "(".
  const short = new Map(Object.entries(HEAD).map(([k, v]) => [norm(v.replace(/\s*\(.*\)\s*$/, '')), k]));
  const head = {};
  let headRow = null;
  const last = Math.min(ws.rowCount, MAX_ROWS + 50);
  for (let i = 1; i <= last; i += 1) {
    const a = norm(cellText(ws.getCell(i, 1).value));
    if (!a) continue;
    if (a === norm(COL.code)) { headRow = i; break; }
    const key = labels.get(a) ?? short.get(a.replace(/\s*\(.*\)\s*$/, ''));
    if (key) head[key] = { text: cellText(ws.getCell(i, 2).value), raw: ws.getCell(i, 2).value };
  }
  if (!headRow) throw invalid('BAD_FILE', `The sheet has no row starting "${COL.code}" — the lines table could not be found. Download the GRN sheet and fill that.`);
  const cols = {};
  const want = new Map(Object.entries(COL).map(([k, v]) => [norm(v), k]));
  const wantShort = new Map(Object.entries(COL).map(([k, v]) => [norm(v.replace(/\s*\(.*\)\s*$/, '').replace(/\s*₹$/, '')), k]));
  ws.getRow(headRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const t = norm(cellText(cell.value));
    const k = want.get(t) ?? wantShort.get(t.replace(/\s*\(.*\)\s*$/, '').replace(/\s*₹$/, ''));
    if (k && !cols[k]) cols[k] = col;
  });
  for (const k of ['code', 'qty']) if (!cols[k]) problems.push(`The lines table has no "${COL[k]}" column.`);
  const rows = [];
  if (!cols.code || !cols.qty) return { head, rows };
  for (let i = headRow + 1; i <= ws.rowCount && rows.length <= MAX_ROWS; i += 1) {
    const get = (k) => (cols[k] ? cellText(ws.getCell(i, cols[k]).value) : '');
    const code = get('code');
    const qty = get('qty');
    if (blank(code) && blank(qty)) continue;
    rows.push({ excelRow: i, code, qty: numText(qty), price: numText(get('price')), hsn: get('hsn'), gst: numText(get('gst')), lot: get('lot'), batch: get('batch'), name: get('name') });
  }
  if (rows.length > MAX_ROWS) problems.push(`At most ${MAX_ROWS} rows in one sheet.`);
  return { head, rows };
}

const problemsOf = (e) => (e instanceof CfError ? (Array.isArray(e.problems) && e.problems.length ? e.problems : [e.message]) : null);

/**
 * POST /purchase-orders/:id/grn-sheet — { fileBase64, dryRun? }. Needs a transaction.
 * -> { dryRun, applied, ok, problems[], notes[], warnings[], changes[], summary: { sentence, lines, quantity, total }, money?,
 *      and when applied the dialog's own answer: bill, movements, held, order }
 */
export async function importGrnSheet(db, c, poId, input = {}) {
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to import — send the file as `fileBase64`.');
  let buffer;
  try { buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64'); } catch { throw invalid('BAD_FILE', 'That file could not be read — send it as base64.'); }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');

  const po = await getPurchaseOrder(db, c.companyId, poId);
  const problems = [];
  const notes = [];
  const { head, rows } = await readSheet(buffer, problems);
  const H = (k) => head[k]?.text ?? '';

  // ---- which PO the file was made for: a note, never a refusal ----
  if (!blank(H('po')) && norm(H('po')) !== norm(po.code)) notes.push(`File made for ${H('po')}, applying to ${po.code}.`);
  if (!blank(H('supplier')) && po.supplier && norm(H('supplier')) !== norm(po.supplier.name)) notes.push(`The file names supplier "${H('supplier')}"; ${po.code} is from ${po.supplier.name}.`);

  // ---- the store, by code ----
  let stockingAreaId = null;
  if (blank(H('store'))) problems.push(`Give the ${HEAD.store} the goods went into.`);
  else {
    const [[area]] = await db.query('SELECT id, code, purpose, status FROM cf_stocking_areas WHERE company_id = ? AND LOWER(code) = LOWER(?) AND deleted_at IS NULL', [c.companyId, H('store').trim()]);
    if (!area) problems.push(`There is no stocking area with code "${H('store')}".`);
    else if (area.status !== 'active') problems.push(`${area.code} is not active.`);
    else if (!RECEIVING_PURPOSES.includes(area.purpose)) problems.push(`${area.code} is a ${area.purpose} area — goods from a purchase go into a store (or quarantine for inspection).`);
    else stockingAreaId = area.id;
  }

  // ---- invoice and charges ----
  const follow = norm(H('toFollow'));
  let pendingInvoice = false;
  if (['yes', 'y', 'true', '1'].includes(follow)) pendingInvoice = true;
  else if (follow && !['no', 'n', 'false', '0'].includes(follow)) problems.push(`${HEAD.toFollow}: Yes or No (it says "${H('toFollow')}").`);
  const invoiceDate = dateIn(H('invoiceDate'));
  const charge = (amountKey, gstKey) => {
    const amount = numText(H(amountKey));
    const gst = numText(H(gstKey));
    return { amount: amount || '0', taxable: !blank(gst), ...(blank(gst) ? {} : { gstRate: gst }) };
  };

  // ---- the rows, by item code ----
  const pendingLines = po.lines.filter((l) => l.pending > EPS);
  const byCode = new Map();
  for (const l of pendingLines) {
    const k = norm(l.item.code);
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(l);
  }
  const allByCode = new Map(po.lines.map((l) => [norm(l.item.code), l]));
  const groups = new Map();     // code -> { rows: [...], qty }
  let leftOut = 0;
  for (const row of rows) {
    const at = `Row ${row.excelRow}`;
    if (blank(row.qty) || Number(row.qty) === 0) { leftOut += 1; continue; }
    const q = Number(row.qty);
    if (!Number.isFinite(q) || q < 0) { problems.push(`${at} (${row.code || 'no code'}): ${COL.qty} is a number, zero or more (it says "${row.qty}").`); continue; }
    if (blank(row.code)) { problems.push(`${at}: ${COL.qty} ${fmt(q)} but no ${COL.code}.`); continue; }
    const k = norm(row.code);
    if (!byCode.has(k)) {
      const l = allByCode.get(k);
      problems.push(l ? `${at}: ${row.code} has nothing pending on ${po.code}.` : `${at}: ${row.code} is not on ${po.code}.`);
      continue;
    }
    if (!groups.has(k)) groups.set(k, { rows: [], qty: 0 });
    const g = groups.get(k);
    g.rows.push(row);
    g.qty = round6(g.qty + q);
  }

  // Batch codes named in the sheet, read in one go.
  const batchCodes = [...new Set([...groups.values()].flatMap((g) => g.rows.map((r) => r.batch)).filter((b) => !blank(b)).map((b) => b.trim().toLowerCase()))];
  const [batchRows] = batchCodes.length
    ? await db.query('SELECT id, code, item_id, status FROM cf_stock_batches WHERE company_id = ? AND LOWER(code) IN (?) AND deleted_at IS NULL', [c.companyId, batchCodes])
    : [[]];

  const lines = [];
  const changes = [];
  for (const [k, g] of groups) {
    const poLines = byCode.get(k);
    const first = g.rows[0];
    const label = poLines[0].item.code ?? poLines[0].item.name;
    // Several rows of one item must agree on what describes the delivery.
    for (const f of ['price', 'hsn', 'gst', 'lot', 'batch']) {
      const vals = new Set(g.rows.map((r) => norm(r[f])));
      if (vals.size > 1) problems.push(`${label}: its rows (${g.rows.map((r) => r.excelRow).join(', ')}) give different ${COL[f]} values — one delivery of an item has one.`);
    }
    const totalPending = round6(poLines.reduce((t, l) => t + l.pending, 0));
    if (g.qty > totalPending + EPS) { problems.push(`${label}: ${fmt(g.qty)} ${poLines[0].item.uom ?? ''} to receive, but only ${fmt(totalPending)} is pending on ${po.code}.`.replace(/ {2}/g, ' ')); continue; }
    if (poLines.length > 1) notes.push(`${label} is on ${poLines.length} lines of ${po.code} — ${fmt(g.qty)} is filled in line order.`);

    // The batch it arrives in.
    const byBatch = poLines[0].item.trackedBy === 'batch';
    let batchId = null;
    let batch = null;
    if (byBatch) {
      if (!blank(first.batch)) {
        const b = batchRows.find((x) => x.code.toLowerCase() === first.batch.trim().toLowerCase());
        if (!b) problems.push(`${label}: there is no batch "${first.batch}".`);
        else if (Number(b.item_id) !== Number(poLines[0].item.id)) problems.push(`${label}: batch ${b.code} is of another item.`);
        else if (b.status === 'rejected') problems.push(`${label}: batch ${b.code} is rejected — give a heat / lot number for a new batch instead.`);
        else batchId = Number(b.id);
      } else if (blank(first.lot)) problems.push(`${label} is kept by batch — give the ${COL.lot} (a new batch), or an existing batch code under "${COL.batch}".`);
      else batch = { supplierRef: first.lot.trim(), values: [] };
    } else if (!blank(first.lot) || !blank(first.batch)) {
      notes.push(`${label} is counted by quantity, not by batch — its lot / batch cell is ignored.`);
    }

    let left = g.qty;
    for (const l of poLines) {
      if (left <= EPS) break;
      const take = round6(Math.min(left, l.pending));
      left = round6(left - take);
      lines.push({
        lineId: l.id, quantity: take,
        ...(blank(first.price) ? {} : { unitPrice: first.price }),
        ...(blank(first.hsn) ? {} : { hsnCode: first.hsn.trim() }),
        ...(blank(first.gst) ? {} : { gstRate: first.gst }),
        ...(batchId ? { batchId } : {}), ...(batch ? { batch } : {}),
      });
      changes.push({
        action: 'receive', lineId: l.id, lineNo: l.lineNo, itemCode: l.item.code, itemName: l.item.name, uom: l.item.uom,
        quantity: take, pending: l.pending, rows: g.rows.map((r) => r.excelRow),
        unitPrice: blank(first.price) ? l.unitPrice : Number(first.price),
        batch: batchId ? first.batch.trim() : batch ? `new · ${batch.supplierRef}` : null,
        detail: `${fmt(take)} of ${fmt(l.pending)} ${l.item.uom ?? ''} pending`.trim(),
      });
    }
  }
  if (!rows.length) problems.push('The sheet has no rows under the lines table.');
  else if (!groups.size && !problems.length) problems.push(`Every row has a ${COL.qty} of 0 or blank — there is nothing to receive.`);
  if (leftOut) notes.push(`${plural(leftOut, 'row', 'rows')} with a ${COL.qty} of 0 or blank left out.`);

  const body = {
    stockingAreaId, reference: blank(H('reference')) ? null : H('reference').trim(),
    invoice: { no: blank(H('invoiceNo')) ? undefined : H('invoiceNo').trim(), date: invoiceDate ?? undefined, pending: pendingInvoice },
    charges: { freight: charge('freight', 'freightGst'), other: charge('other', 'otherGst') },
    lines,
  };

  // The GRN's own checks — every one at once — beside the sheet's.
  let preview = null;
  if (lines.length) {
    try { preview = await receiveGrn(db, c, po.id, { ...body, dryRun: true }); } catch (e) { const p = problemsOf(e); if (!p) throw e; problems.push(...p); }
  }
  const quantity = round6(changes.reduce((t, x) => t + x.quantity, 0));
  const summary = (extra = '') => ({
    lines: changes.length, quantity,
    total: preview?.money?.totals?.total ?? null,
    sentence: problems.length
      ? `${plural(problems.length, 'problem', 'problems')} — nothing booked`
      : `${dryRun ? 'Would book' : 'Booked'} one GRN on ${po.code}: ${plural(changes.length, 'line', 'lines')}${preview?.money?.totals?.total != null ? `, bill total ₹${preview.money.totals.total.toFixed(2)}` : ''}${extra}`,
  });
  const base = { dryRun, notes, changes, purchaseOrder: { id: po.id, code: po.code } };
  if (problems.length) return { ...base, applied: false, ok: false, problems, warnings: preview?.warnings ?? [], summary: summary() };

  // The real booking, inside a savepoint: a dry run rolls it back; a refusal only the booking finds is reported, not half-kept.
  const sp = `grn_sheet_${Date.now().toString(36)}`;
  await db.query(`SAVEPOINT ${sp}`);
  let res;
  try {
    res = await receiveGrn(db, c, po.id, body);
  } catch (e) {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    const p = problemsOf(e);
    if (!p) throw e;
    return { ...base, applied: false, ok: false, problems: p, warnings: preview?.warnings ?? [], summary: { ...summary(), sentence: `${plural(p.length, 'problem', 'problems')} — nothing booked` } };
  }
  if (dryRun) {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    return { ...base, applied: false, ok: true, problems: [], warnings: res.warnings ?? [], money: res.money, summary: summary() };
  }
  await db.query(`RELEASE SAVEPOINT ${sp}`);
  return {
    ...base, applied: true, ok: true, problems: [], warnings: res.warnings ?? [], money: res.money, summary: summary(` (${res.bill?.lineCount ?? changes.length} receipts)`),
    bill: res.bill, movements: res.movements, held: res.held, order: res.order,
  };
}
