/**
 * buyingSheetService.js — the buying chain as spreadsheets, out and back in (user, 2026-10-31: "We need excel for
 * everything — MR, PR, PR-Quotations, PO"). The house pattern of orderSheetService / routes/bomSheet.js:
 *
 *   GET  …/sheet              the .xlsx — row 1 says how to fill it, then a header row; grey = read only, white = typed
 *   POST …/sheet              { fileBase64, dryRun? } → { ok, problems[], changes[], summary.sentence, applied? }
 *
 * THREE SHEETS
 *   Material request   one row per MR line: item code, name, UOM, required, in stock (free), TAKE FROM STOCK, to buy,
 *                      issued. The upload sets take from stock per item code — purchaseRequestService.saveMr, the very
 *                      save behind the screen's Save (PUT /material-requests/:id).
 *   Purchase request   the quote grid: one row per PR line (item code, name, needed, to order) and, per vendor column,
 *                      "<SUPPLIER CODE> rate | days | remark". A supplier code not yet on the PR adds its column
 *                      (addVendor — an active supplier party, else a problem); the cells go through setQuotes, the grid's
 *                      own quote save. Or LONG: one row per item × supplier (item code, supplier code, rate, delivery
 *                      days, remark) — told apart by a "Supplier code" header.
 *   Purchase order     header facts (PO no., supplier, status, expected date) then the lines: item code, name, UOM, qty,
 *                      received, pending, unit price, GST rate, amount, expected date. While the PO may still change (not
 *                      placed / waiting for Management approval — the screen's own rule) the upload sets quantity, unit
 *                      price and expected date per item code and the PO's own expected date, through
 *                      purchaseService.updatePurchaseLine / updatePurchaseOrder; once approved it is refused in words.
 *
 * BUSINESS KEYS, NOT HIDDEN IDS. Rows are matched by ITEM CODE and vendor columns by SUPPLIER CODE, so a sheet prepared
 * by hand — or downloaded from another record holding the same items — reads back onto this one. Grey columns are never
 * read. An EMPTY cell leaves the value as it is; a literal "-" clears it (where clearing means something).
 *
 * DRY RUN = THE REAL SAVE IN A SAVEPOINT, ROLLED BACK (as bomChangeService): every rule of the screen's save runs, and
 * whatever it refuses comes back as problems, all at once. Applying refuses the whole file if anything is wrong.
 */
import ExcelJS from 'exceljs';
import { CfError, invalid, conflict, notFound, assertNoProblems, translateDbError } from '../lib/errors.js';
import { mrScreen, saveMr, getPr, addVendor, setQuotes } from './purchaseRequestService.js';
import { getPurchaseOrder, updatePurchaseOrder, updatePurchaseLine } from './purchaseService.js';

const EPS = 1e-6;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const EDGE = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };
const CLEAR = '-';

const blank = (v) => v == null || String(v).trim() === '';
const round6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
const fmt = (n) => String(Number(Number(n).toFixed(3)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const keyOf = (s) => String(s ?? '').trim().toUpperCase();
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => {
  if (d == null || d === '') return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d).slice(0, 10);
};
/** A date cell as Excel stores it (UTC midnight), so it reads back as the same day anywhere. */
const dateCell = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** One cell as plain text: formulas, rich text, hyperlinks and dates flattened (a date → YYYY-MM-DD). */
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return cellText(v.hyperlink);
    return '';
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v).trim();
}

/** A typed date: YYYY-MM-DD, or DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY. null = not a date. */
function readDateText(t) {
  const s = String(t ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m.map(Number);
  else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!m) return null;
    [, d, mo, y] = m.map(Number);
  }
  const x = new Date(Date.UTC(y, mo - 1, d));
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== mo - 1 || x.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/* ===========================================================================
 * Writing
 * ======================================================================== */

/** A workbook with one sheet: the banner on row 1. → { wb, ws } */
function newSheet(name, banner) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet(name);
  const r = ws.addRow([banner]);
  r.font = { italic: true, color: { argb: 'FF595959' } };
  r.height = 20;
  return { wb, ws };
}

/**
 * The header row and the rows under it. cols: [{ header, width, editable?, numFmt?, note? }]; rows: arrays of values.
 * Grey = read only, white = typed. Freezes everything above the first data row.
 */
function writeTable(ws, cols, rows) {
  const head = ws.addRow(cols.map((c) => c.header));
  head.eachCell((cell, i) => {
    cell.fill = HEAD;
    cell.font = { bold: true };
    cell.border = BOX;
    if (cols[i - 1]?.note) cell.note = cols[i - 1].note;
  });
  const headRow = head.number;
  for (const values of rows) {
    const r = ws.addRow(values);
    cols.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      cell.border = BOX;
      if (!c.editable) cell.fill = GREY;
      if (c.numFmt) cell.numFmt = c.numFmt;
    });
  }
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 14; });
  ws.views = [{ state: 'frozen', ySplit: headRow }];
  return headRow;
}

async function finish(wb, stem, rows) {
  return {
    filename: `${String(stem).replace(/[^\w.-]+/g, '_')}.xlsx`,
    contentType: XLSX,
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    rows,
  };
}

/* ===========================================================================
 * Reading
 * ======================================================================== */

const looksXlsx = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

/** The upload's bytes, or a 422 in words. */
function bufferOf(input) {
  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to import — send the file as `fileBase64`.');
  let buffer;
  try {
    buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64');
  } catch {
    throw invalid('BAD_FILE', 'That file could not be read — send it as base64.');
  }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');
  if (!looksXlsx(buffer)) throw invalid('BAD_FILE', 'That is not an Excel workbook (.xlsx). Download the sheet, fill it in and upload that file.');
  return buffer;
}

/** Every row of the first sheet as { n (sheet row), cells: [text by 1-based column] }. */
async function readRows(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid('BAD_FILE', 'That file could not be opened as an Excel workbook (.xlsx).'); }
  const ws = wb.worksheets.find((w) => w.state !== 'veryHidden' && w.state !== 'hidden') ?? wb.worksheets[0];
  if (!ws) throw invalid('EMPTY_SHEET', 'That workbook has no sheets in it.');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const cells = [];
    const count = Math.max(row.cellCount, row.actualCellCount);
    for (let i = 1; i <= count; i++) cells[i] = cellText(row.getCell(i).value);
    rows.push({ n, cells });
  });
  return rows;
}

/** The first row (of the first 15) with a cell matching `test` — the header row. */
function findHeader(rows, test) {
  return rows.slice(0, 15).find((r) => r.cells.some((t) => test(norm(t)))) ?? null;
}

/** The column (1-based) whose header matches one of `names` (normalised), or 0. */
function colOf(header, names) {
  const want = names.map(norm);
  for (let i = 1; i < header.cells.length; i++) if (want.includes(norm(header.cells[i]))) return i;
  return 0;
}

const isItemCode = (t) => t === 'item code' || t === 'item' || t === 'code' || t === 'material code';

/* ===========================================================================
 * Shared report + savepoint run
 * ======================================================================== */

const dryRunOf = (input) => input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';

let spSeq = 0;
/**
 * Runs `steps` ([{ label, fn }]) inside one SAVEPOINT, one after another. A refusal a person can act on (a CfError)
 * becomes problems, labelled, and the next steps still run (so every refusal comes back at once); anything else is
 * rethrown. Rolled back when `dryRun` or when anything was refused. → { problems, outs }
 */
async function inSavepoint(db, dryRun, steps) {
  spSeq = (spSeq + 1) % 1e6;
  const sp = `buying_sheet_${spSeq}`;
  await db.query(`SAVEPOINT ${sp}`);
  const problems = [];
  const outs = [];
  try {
    for (const s of steps) {
      try {
        outs.push(await s.fn(outs));
      } catch (raw) {
        const e = translateDbError(raw);
        if (!(e instanceof CfError)) throw raw;
        const list = Array.isArray(e.problems) && e.problems.length ? e.problems : [e.message];
        for (const p of list) problems.push(s.label ? `${s.label}: ${p}` : p);
        outs.push(null);
      }
    }
    if (dryRun || problems.length) await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    else await db.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (err) {
    try { await db.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* the original error is the one that matters */ }
    throw err;
  }
  return { problems, outs };
}

/** Item codes that are not on the record: which exist at all. 1 read. → Set of known codes (upper case). */
async function knownItemCodes(db, companyId, codes) {
  if (!codes.length) return new Set();
  const [rows] = await db.query(
    `SELECT m.code FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND UPPER(m.code) IN (?)`,
    [companyId, codes.map(keyOf)],
  );
  return new Set(rows.map((r) => keyOf(r.code)));
}

/** "Row N: <code> is not on X" or "no item has that code", for every row whose item code did not match. */
async function unmatchedProblems(db, companyId, misses, where, problems) {
  if (!misses.length) return;
  const known = await knownItemCodes(db, companyId, [...new Set(misses.map((m) => m.code))]);
  for (const m of misses) {
    problems.push(known.has(keyOf(m.code))
      ? `Row ${m.n}: ${m.code} is not on ${where}.`
      : `Row ${m.n}: no item has the code "${m.code}".`);
  }
}

/** The answer of every upload (the shape the Structure grid's preview dialog reads). */
function report({ dryRun, problems, changes, summary, record, applied = false, extra = {} }) {
  return {
    dryRun, ok: problems.length === 0, problems, changes,
    summary: { ...summary, sentence: problems.length && !dryRun ? 'nothing — fix the sheet first' : summary.sentence },
    record, ...(applied ? { applied: true } : {}), ...extra,
  };
}

/** Every problem at once: a dry run answers them, a real upload throws them (422 with `problems`). */
function refuseOrReport(args, what) {
  if (!args.problems.length) return null;
  if (args.dryRun) return report({ ...args, summary: { ...args.summary, sentence: 'nothing — fix the sheet first' } });
  assertNoProblems(args.problems, `That sheet was not applied to ${what} — ${plural(args.problems.length, 'problem', 'problems')} to fix first.`);
  return null;
}

/** A number cell: null = empty (leave as is); NaN = not a number. */
const numberCell = (t) => (blank(t) ? null : Number(String(t).replace(/,/g, '').trim()));

/* ===========================================================================
 * 1. MATERIAL REQUEST
 * ======================================================================== */

const MR_COLS = [
  { header: 'Item code', width: 22 },
  { header: 'Name', width: 36 },
  { header: 'UOM', width: 8 },
  { header: 'Required', width: 12, numFmt: '0.###' },
  { header: 'In stock (free)', width: 15, numFmt: '0.###' },
  { header: 'Take from stock', width: 16, editable: true, numFmt: '0.###' },
  { header: 'To buy', width: 12, numFmt: '0.###' },
  { header: 'Issued', width: 12, numFmt: '0.###' },
];
export const MR_BANNER = 'Type how much to take from stock in the white column, then upload; rows are matched by item code. Grey columns are for reading.';

/** What the screen's box starts with: the saved take, or — nothing chosen yet — the proposal. */
const mrTakeShown = (l) => (!l.takeChosen && l.proposedTake != null ? l.proposedTake : l.takeFromStock);

/** GET /material-requests/:id/sheet */
export async function exportMrSheet(db, companyId, id) {
  const m = await mrScreen(db, companyId, id);
  const { wb, ws } = newSheet('MR', MR_BANNER);
  writeTable(ws, MR_COLS, m.lines.map((l) => [
    l.item.code ?? '', l.item.name ?? '', l.item.uom ?? '', l.required, l.inStock, mrTakeShown(l), l.toBuy, l.issued ?? 0,
  ]));
  return finish(wb, m.code, m.lines.length);
}

/** POST /material-requests/:id/sheet { fileBase64, dryRun?, customerDate? } — take from stock per item code, then saveMr. */
export async function importMrSheet(db, c, id, input = {}) {
  const dryRun = dryRunOf(input);
  const buffer = bufferOf(input);
  const m = await mrScreen(db, c.companyId, id);
  const record = { kind: 'material_request', id: m.id, code: m.code };
  if (!m.canEdit) throw conflict('NOT_EDITABLE', m.reason ?? `${m.code} can no longer be changed.`);
  const rows = await readRows(buffer);
  const problems = [];
  const changes = [];
  const summary = { rowsInSheet: 0, rowsMatched: 0, changed: 0, unchanged: 0, sentence: '' };
  const args = { dryRun, problems, changes, summary, record };
  const header = findHeader(rows, isItemCode);
  const codeCol = header ? colOf(header, ['Item code', 'Item', 'Code', 'Material code']) : 0;
  const takeCol = header ? colOf(header, ['Take from stock', 'Take', 'From stock']) : 0;
  if (!header || !codeCol || !takeCol) {
    problems.push('The sheet needs an "Item code" column and a "Take from stock" column under row 1. Download the MR sheet to see the layout.');
    return refuseOrReport(args, m.code);
  }
  const byCode = new Map();
  for (const l of m.lines) {
    const k = keyOf(l.item.code);
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(l);
  }
  const seen = new Map();
  const misses = [];
  const want = [];
  for (const r of rows.filter((x) => x.n > header.n)) {
    const code = r.cells[codeCol] ?? '';
    const take = r.cells[takeCol] ?? '';
    if (blank(code) && blank(take)) continue;
    summary.rowsInSheet += 1;
    if (blank(code)) { problems.push(`Row ${r.n}: there is no item code.`); continue; }
    const k = keyOf(code);
    if (seen.has(k)) { problems.push(`Row ${r.n}: ${code} is also on row ${seen.get(k)} — one row per item.`); continue; }
    seen.set(k, r.n);
    const lines = byCode.get(k);
    if (!lines) { misses.push({ n: r.n, code }); continue; }
    if (lines.length > 1) { problems.push(`Row ${r.n}: ${code} is on ${m.code} ${lines.length} times — change it on the screen.`); continue; }
    summary.rowsMatched += 1;
    if (blank(take)) { summary.unchanged += 1; continue; }
    const l = lines[0];
    const t = numberCell(take);
    if (!Number.isFinite(t) || t < 0) { problems.push(`Row ${r.n}: ${code} — take from stock is a number, zero or more ("${take}" is not).`); continue; }
    if (l.takeChosen && Math.abs(t - l.takeFromStock) < EPS) { summary.unchanged += 1; continue; }
    want.push({ lineId: l.id, takeFromStock: round6(t) });
    changes.push({ action: 'update', path: l.item.code, field: 'Take from stock', from: l.takeChosen ? l.takeFromStock : null, to: round6(t) });
  }
  await unmatchedProblems(db, c.companyId, misses, m.code, problems);
  const refused = refuseOrReport(args, m.code);
  if (refused) return refused;
  summary.changed = want.length;
  if (!want.length) return report({ ...args, summary: { ...summary, sentence: 'nothing to change' } });
  summary.sentence = `take from stock changed on ${plural(want.length, 'line', 'lines')}`;
  const run = await inSavepoint(db, dryRun, [{
    label: '', fn: () => saveMr(db, c, m.id, { lines: want, ...(input.customerDate ? { customerDate: input.customerDate } : {}) }),
  }]);
  problems.push(...run.problems);
  const refused2 = refuseOrReport(args, m.code);
  if (refused2) return refused2;
  if (dryRun) return report(args);
  return report({ ...args, applied: true, extra: { materialRequest: run.outs[0] } });
}

/* ===========================================================================
 * 2. PURCHASE REQUEST — the quote grid
 * ======================================================================== */

export const PR_BANNER = 'Type each vendor\'s rate, delivery days and remark in the white cells (rows by item code, vendors by the supplier code heading the columns; three new columns "<CODE> rate / days / remark" add a vendor). Empty = leave as is, "-" = clear.';
const SUFFIX = [
  { field: 'rate', re: /^(.*?)[\s·:|]*(?:rate|price)$/i },
  { field: 'days', re: /^(.*?)[\s·:|]*(?:delivery days|days|delivery)$/i },
  { field: 'remark', re: /^(.*?)[\s·:|]*(?:remarks?|note)$/i },
];
/** "SAIL-HYD rate" → { code: 'SAIL-HYD', field: 'rate' }; null when the header is no vendor column. */
function vendorHeader(text) {
  const t = String(text ?? '').trim();
  for (const s of SUFFIX) {
    const m = s.re.exec(t);
    if (m) {
      const code = m[1].replace(/[\s·:|–—-]+$/, '').trim();
      if (code) return { code, field: s.field };
    }
  }
  return null;
}
/** The lines the grid shows (a line with nothing needed and no PO is not on the screen). */
const prLinesShown = (p) => p.lines.filter((l) => l.needed > EPS || l.poRaised > EPS);

/** GET /purchase-requests/:id/sheet */
export async function exportPrSheet(db, companyId, id) {
  const p = await getPr(db, companyId, id);
  const lines = prLinesShown(p);
  const { wb, ws } = newSheet('Quotes', PR_BANNER);
  const cols = [
    { header: 'Item code', width: 22 },
    { header: 'Name', width: 34 },
    { header: 'UOM', width: 8 },
    { header: 'Needed', width: 11, numFmt: '0.###' },
    { header: 'To order', width: 11, numFmt: '0.###' },
  ];
  for (const v of p.vendors) {
    const code = v.supplier.code || `#${v.supplier.id}`;
    cols.push(
      { header: `${code} rate`, width: 14, editable: true, numFmt: '0.00', note: `${v.supplier.name} — rate per unit` },
      { header: `${code} days`, width: 11, editable: true, numFmt: '0', note: `${v.supplier.name} — delivery days` },
      { header: `${code} remark`, width: 22, editable: true, note: `${v.supplier.name} — remark` },
    );
  }
  writeTable(ws, cols, lines.map((l) => [
    l.item.code ?? '', l.item.name ?? '', l.item.uom ?? '', l.needed, l.open,
    ...p.vendors.flatMap((v) => {
      const q = v.quotes[l.id];
      return q ? [q.rate, q.deliveryDays, q.remark ?? null] : [null, null, null];
    }),
  ]));
  return finish(wb, `${p.code}_quotes`, lines.length);
}

/**
 * POST /purchase-requests/:id/sheet { fileBase64, dryRun? } — the quote grid back in. Wide (vendor columns) or long
 * (one row per item × supplier), told apart by a "Supplier code" header.
 */
export async function importPrSheet(db, c, id, input = {}) {
  const dryRun = dryRunOf(input);
  const buffer = bufferOf(input);
  const p = await getPr(db, c.companyId, id);
  const record = { kind: 'purchase_request', id: p.id, code: p.code };
  if (!p.canEdit) throw conflict('NOT_OPEN', `${p.order?.code ?? p.code} is ${p.order?.status ?? 'closed'} — nothing more is bought for it.`);
  const rows = await readRows(buffer);
  const problems = [];
  const changes = [];
  const summary = { rowsInSheet: 0, rowsMatched: 0, vendorsAdded: 0, quotesChanged: 0, unchanged: 0, sentence: '' };
  const args = { dryRun, problems, changes, summary, record };
  const header = findHeader(rows, isItemCode);
  const codeCol = header ? colOf(header, ['Item code', 'Item', 'Code', 'Material code']) : 0;
  if (!header || !codeCol) {
    problems.push('The sheet needs an "Item code" column under row 1. Download the quote sheet to see the layout.');
    return refuseOrReport(args, p.code);
  }
  const supCol = colOf(header, ['Supplier code', 'Supplier', 'Vendor code', 'Vendor']);
  // cells: [{ n, code (item), sup (supplier code), rate, days, remark (texts; undefined = no such column) }]
  const cells = [];
  let format = 'wide';
  if (supCol) {
    format = 'long';
    const rateCol = colOf(header, ['Rate', 'Price', 'Unit price']);
    const daysCol = colOf(header, ['Delivery days', 'Days', 'Delivery']);
    const remarkCol = colOf(header, ['Remark', 'Remarks', 'Note']);
    if (!rateCol && !daysCol && !remarkCol) {
      problems.push('A sheet with a "Supplier code" column needs a "Rate", "Delivery days" or "Remark" column too.');
      return refuseOrReport(args, p.code);
    }
    for (const r of rows.filter((x) => x.n > header.n)) {
      const code = r.cells[codeCol] ?? '';
      const sup = r.cells[supCol] ?? '';
      const rate = rateCol ? r.cells[rateCol] ?? '' : undefined;
      const days = daysCol ? r.cells[daysCol] ?? '' : undefined;
      const remark = remarkCol ? r.cells[remarkCol] ?? '' : undefined;
      if (blank(code) && blank(sup) && blank(rate) && blank(days) && blank(remark)) continue;
      summary.rowsInSheet += 1;
      if (blank(code)) { problems.push(`Row ${r.n}: there is no item code.`); continue; }
      if (blank(sup)) { problems.push(`Row ${r.n}: ${code} — there is no supplier code.`); continue; }
      cells.push({ n: r.n, code, sup, rate, days, remark });
    }
  } else {
    const vcols = [];
    for (let i = 1; i < header.cells.length; i++) {
      if (i === codeCol) continue;
      const v = vendorHeader(header.cells[i]);
      if (v && !['to order', 'needed', 'name', 'uom'].includes(norm(v.code))) vcols.push({ col: i, ...v });
    }
    const bySup = new Map();
    for (const v of vcols) {
      const k = keyOf(v.code);
      if (!bySup.has(k)) bySup.set(k, { code: v.code });
      const s = bySup.get(k);
      if (s[v.field]) problems.push(`Two "${v.code} ${v.field}" columns — keep one.`);
      s[v.field] = v.col;
    }
    if (!bySup.size) {
      problems.push('No vendor columns found: head them "<SUPPLIER CODE> rate", "<SUPPLIER CODE> days", "<SUPPLIER CODE> remark" — or use a "Supplier code" column, one row per item and supplier.');
      return refuseOrReport(args, p.code);
    }
    for (const r of rows.filter((x) => x.n > header.n)) {
      const code = r.cells[codeCol] ?? '';
      const own = [...bySup.values()].map((s) => ({
        sup: s.code,
        rate: s.rate ? r.cells[s.rate] ?? '' : undefined,
        days: s.days ? r.cells[s.days] ?? '' : undefined,
        remark: s.remark ? r.cells[s.remark] ?? '' : undefined,
      }));
      const any = own.some((x) => !blank(x.rate) || !blank(x.days) || !blank(x.remark));
      if (blank(code) && !any) continue;
      summary.rowsInSheet += 1;
      if (blank(code)) { problems.push(`Row ${r.n}: there is no item code.`); continue; }
      cells.push({ n: r.n, code, rowOnly: true });
      for (const x of own) if (!blank(x.rate) || !blank(x.days) || !blank(x.remark)) cells.push({ n: r.n, code, ...x });
    }
  }

  // ---- items: by code, onto the PR's lines ----------------------------------------------------------
  const shown = new Set(prLinesShown(p).map((l) => l.id));
  const byCode = new Map();
  for (const l of p.lines) {
    const k = keyOf(l.item.code);
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(l);
  }
  const lineOfCode = new Map();
  const misses = [];
  const matchedRows = new Set();
  for (const x of cells) {
    const k = keyOf(x.code);
    if (lineOfCode.has(k)) { if (lineOfCode.get(k)) matchedRows.add(x.n); continue; }
    const all = byCode.get(k) ?? [];
    const live = all.filter((l) => shown.has(l.id));
    const pick = live.length ? live : all;
    if (!pick.length) { misses.push({ n: x.n, code: x.code }); lineOfCode.set(k, null); continue; }
    if (pick.length > 1) { problems.push(`Row ${x.n}: ${x.code} is on ${p.code} ${pick.length} times — quote it on the screen.`); lineOfCode.set(k, null); continue; }
    lineOfCode.set(k, pick[0]);
    matchedRows.add(x.n);
  }
  summary.rowsMatched = matchedRows.size;
  await unmatchedProblems(db, c.companyId, misses, p.code, problems);
  if (format === 'wide') {
    // A row named twice in a wide sheet: the second would overwrite the first.
    const firstRow = new Map();
    for (const x of cells.filter((y) => y.rowOnly)) {
      const k = keyOf(x.code);
      if (firstRow.has(k) && firstRow.get(k) !== x.n) problems.push(`Row ${x.n}: ${x.code} is also on row ${firstRow.get(k)} — one row per item.`);
      else firstRow.set(k, x.n);
    }
  }

  // ---- suppliers: by code; a new one adds a vendor column ---------------------------------------------
  const quoteCells = cells.filter((x) => !x.rowOnly);
  const supCodes = [...new Set(quoteCells.map((x) => keyOf(x.sup)))];
  const colOfSup = new Map(p.vendors.map((v) => [keyOf(v.supplier.code), v]));
  const partyOf = new Map();
  if (supCodes.length) {
    const [parties] = await db.query(
      'SELECT id, code, name, is_supplier, status FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND UPPER(code) IN (?)',
      [c.companyId, supCodes],
    );
    for (const s of parties) partyOf.set(keyOf(s.code), s);
  }
  const toAdd = [];
  const badSup = new Set();
  for (const k of supCodes) {
    if (colOfSup.has(k)) continue;
    const s = partyOf.get(k);
    const shownCode = quoteCells.find((x) => keyOf(x.sup) === k).sup;
    if (!s) { problems.push(`Supplier code "${shownCode}": no party has that code.`); badSup.add(k); continue; }
    if (!Number(s.is_supplier)) { problems.push(`Supplier code "${shownCode}": ${s.name} is not marked as a supplier.`); badSup.add(k); continue; }
    if (s.status !== 'active') { problems.push(`Supplier code "${shownCode}": ${s.name} is inactive.`); badSup.add(k); continue; }
    toAdd.push(s);
    changes.push({ action: 'add', path: s.code, detail: `${s.name} added as a vendor` });
  }
  summary.vendorsAdded = toAdd.length;

  // ---- the cells: empty = as it is, "-" = clear ----------------------------------------------------------
  const perSup = new Map(); // supplier key -> Map(lineId -> { rate, deliveryDays, remark })
  const seenCell = new Map();
  for (const x of quoteCells) {
    const k = keyOf(x.sup);
    const line = lineOfCode.get(keyOf(x.code));
    if (!line || badSup.has(k)) continue;
    const ck = `${k}|${line.id}`;
    if (seenCell.has(ck)) { problems.push(`Row ${x.n}: ${x.code} / ${x.sup} is also on row ${seenCell.get(ck)} — one quote per item and supplier.`); continue; }
    seenCell.set(ck, x.n);
    const was = colOfSup.get(k)?.quotes?.[line.id] ?? null;
    const where = `Row ${x.n}: ${x.code} / ${x.sup}`;
    const clearAll = String(x.rate ?? '').trim() === CLEAR;
    let rate = was?.rate ?? null;
    let days = was?.deliveryDays ?? null;
    let remark = was?.remark ?? null;
    if (clearAll) { rate = null; days = null; remark = null; } else {
      if (!blank(x.rate)) {
        const r = numberCell(x.rate);
        if (!Number.isFinite(r) || r < 0) { problems.push(`${where} — the rate is a number, zero or more ("${x.rate}" is not).`); continue; }
        rate = round6(r);
      }
      if (!blank(x.days)) {
        if (String(x.days).trim() === CLEAR) days = null;
        else {
          const d = numberCell(x.days);
          if (!Number.isInteger(d) || d < 0 || d > 3650) { problems.push(`${where} — delivery days is a whole number, zero or more ("${x.days}" is not).`); continue; }
          days = d;
        }
      }
      if (!blank(x.remark)) remark = String(x.remark).trim() === CLEAR ? null : String(x.remark).trim().slice(0, 500);
      if (rate == null && (days != null || remark != null)) { problems.push(`${where} — a quote needs a rate; type the rate too (or "-" in the rate to clear the quote).`); continue; }
    }
    const same = (was?.rate ?? null) === rate && (was?.deliveryDays ?? null) === days && (was?.remark ?? null) === remark;
    if (same) { summary.unchanged += 1; continue; }
    if (!perSup.has(k)) perSup.set(k, new Map());
    perSup.get(k).set(line.id, { rate, deliveryDays: days, remark });
    const fromWords = was ? `₹${fmt(was.rate)}${was.deliveryDays != null ? ` · ${was.deliveryDays} d` : ''}${was.remark ? ` · ${was.remark}` : ''}` : null;
    const toWords = rate == null ? null : `₹${fmt(rate)}${days != null ? ` · ${days} d` : ''}${remark ? ` · ${remark}` : ''}`;
    changes.push({ action: rate == null ? 'remove' : 'update', path: `${line.item.code} / ${x.sup}`, field: 'Quote', from: fromWords, to: toWords });
  }
  summary.quotesChanged = [...perSup.values()].reduce((t, m2) => t + m2.size, 0);
  const refused = refuseOrReport(args, p.code);
  if (refused) return refused;
  if (!toAdd.length && !summary.quotesChanged) return report({ ...args, summary: { ...summary, sentence: 'nothing to change' } });
  const bits = [];
  if (toAdd.length) bits.push(plural(toAdd.length, 'vendor added', 'vendors added'));
  if (summary.quotesChanged) bits.push(plural(summary.quotesChanged, 'quote changed', 'quotes changed'));
  summary.sentence = bits.join(', ');

  // ---- write: the grid's own saves, in one savepoint ----------------------------------------------------
  const steps = toAdd.map((s) => ({ label: `Vendor ${s.code}`, fn: () => addVendor(db, c, p.id, { supplierId: s.id }) }));
  const run = await inSavepoint(db, dryRun, [
    ...steps,
    {
      label: '',
      fn: async () => {
        let now = await getPr(db, c.companyId, p.id);
        const colNow = new Map(now.vendors.map((v) => [keyOf(v.supplier.code), v]));
        for (const [k, cellsOf] of perSup) {
          const v = colNow.get(k);
          if (!v) continue; // its column could not be added — that refusal is already in the problems
          try {
            now = await setQuotes(db, c, v.id, { quotes: [...cellsOf].map(([lineId, q]) => ({ lineId, rate: q.rate, deliveryDays: q.deliveryDays, remark: q.remark })) });
          } catch (e) {
            if (e instanceof CfError) { e.message = `${v.supplier.code}: ${e.message}`; if (Array.isArray(e.problems)) e.problems = e.problems.map((x) => `${v.supplier.code}: ${x}`); }
            throw e;
          }
        }
        return now;
      },
    },
  ]);
  problems.push(...run.problems);
  const refused2 = refuseOrReport(args, p.code);
  if (refused2) return refused2;
  if (dryRun) return report({ ...args, extra: { format } });
  return report({ ...args, applied: true, extra: { format, purchaseRequest: run.outs.at(-1) } });
}

/* ===========================================================================
 * 3. PURCHASE ORDER
 * ======================================================================== */

export const PO_BANNER = 'Change quantity, unit price and expected date in the white cells (rows by item code; the white date under the header is the PO\'s own). Empty = leave as is, "-" clears a price or date. Only before Management approves the PO.';
const PO_LINE_COLS = [
  { header: 'Item code', width: 22 },
  { header: 'Name', width: 34 },
  { header: 'UOM', width: 8 },
  { header: 'Qty', width: 11, editable: true, numFmt: '0.###' },
  { header: 'Received', width: 11, numFmt: '0.###' },
  { header: 'Pending', width: 11, numFmt: '0.###' },
  { header: 'Unit price', width: 13, editable: true, numFmt: '0.00' },
  { header: 'GST rate %', width: 11, numFmt: '0.##' },
  { header: 'Amount', width: 14, numFmt: '#,##0.00' },
  { header: 'Expected date', width: 14, editable: true, numFmt: 'yyyy-mm-dd' },
];
/** The screen's rule (PurchaseOrderDetail: lines and prices change only before Management approves it). */
const PO_EDITABLE_STAGES = new Set(['requested', 'pending_approval']);

/** GET /purchase-orders/:id/sheet */
export async function exportPoSheet(db, companyId, id) {
  const p = await getPurchaseOrder(db, companyId, id);
  const { wb, ws } = newSheet('PO', PO_BANNER);
  const editable = PO_EDITABLE_STAGES.has(p.stage);
  const facts = [
    ['PO no.', p.code],
    ['Supplier', p.supplier ? `${p.supplier.code ?? ''}${p.supplier.code ? ' — ' : ''}${p.supplier.name}` : ''],
    ['Status', p.stageLabel ?? p.status],
    ['Expected date', dateCell(isoOf(p.expectedDate))],
  ];
  for (const [label, value] of facts) {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { bold: true };
    r.getCell(1).fill = HEAD;
    r.getCell(2).border = BOX;
    if (label !== 'Expected date' || !editable) r.getCell(2).fill = GREY;
    if (label === 'Expected date') r.getCell(2).numFmt = 'yyyy-mm-dd';
  }
  ws.addRow([]);
  writeTable(ws, PO_LINE_COLS.map((c2) => ({ ...c2, editable: c2.editable && editable })), p.lines.map((l) => [
    l.item.code ?? '', l.item.name ?? '', l.item.uom ?? '', l.quantity, l.received, l.pending ?? l.outstanding,
    l.unitPrice, l.gstRate ?? null, l.amount, dateCell(isoOf(l.expectedDate)),
  ]));
  return finish(wb, p.code, p.lines.length);
}

/** POST /purchase-orders/:id/sheet { fileBase64, dryRun? } — quantity, unit price, expected date per item code. */
export async function importPoSheet(db, c, id, input = {}) {
  const dryRun = dryRunOf(input);
  const buffer = bufferOf(input);
  const p = await getPurchaseOrder(db, c.companyId, id);
  if (!p) throw notFound('Purchase order');
  const record = { kind: 'purchase_order', id: p.id, code: p.code };
  if (p.status === 'cancelled') throw conflict('CANCELLED', `${p.code} was cancelled — nothing more can change.`);
  if (!PO_EDITABLE_STAGES.has(p.stage)) {
    throw conflict('APPROVED', `${p.code} is ${String(p.stageLabel ?? p.stage).toLowerCase()} — changing an approved PO is not allowed. Quantities, prices and dates change only before Management approves it.`);
  }
  const rows = await readRows(buffer);
  const problems = [];
  const changes = [];
  const summary = { rowsInSheet: 0, rowsMatched: 0, linesChanged: 0, headerChanged: 0, unchanged: 0, sentence: '' };
  const args = { dryRun, problems, changes, summary, record };
  const header = findHeader(rows, isItemCode);
  if (!header) {
    problems.push('The sheet needs a row of headings with "Item code". Download the PO sheet to see the layout.');
    return refuseOrReport(args, p.code);
  }
  const codeCol = colOf(header, ['Item code', 'Item', 'Code', 'Material code']);
  const qtyCol = colOf(header, ['Qty', 'Quantity']);
  const priceCol = colOf(header, ['Unit price', 'Price', 'Rate']);
  const dateCol = colOf(header, ['Expected date', 'Date', 'Delivery date']);
  if (!qtyCol && !priceCol && !dateCol) {
    problems.push('The sheet has none of the columns "Qty", "Unit price" or "Expected date".');
    return refuseOrReport(args, p.code);
  }
  // The PO's own expected date: the "Expected date" fact above the headings.
  let headDate;
  const fact = rows.find((r) => r.n < header.n && norm(r.cells[1]) === 'expected date');
  if (fact && !blank(fact.cells[2])) {
    const t = fact.cells[2];
    if (t.trim() === CLEAR) headDate = null;
    else {
      const d = readDateText(t);
      if (!d) problems.push(`Row ${fact.n}: the PO's expected date "${t}" is not a date (YYYY-MM-DD).`);
      else headDate = d;
    }
  }
  const before = isoOf(p.expectedDate);
  const headerChange = headDate !== undefined && (headDate ?? null) !== (before ?? null);
  if (headerChange) changes.push({ action: 'update', path: p.code, field: 'Expected date', from: before, to: headDate });

  const byCode = new Map();
  for (const l of p.lines) byCode.set(keyOf(l.item.code), l);
  const seen = new Map();
  const misses = [];
  const writes = [];
  for (const r of rows.filter((x) => x.n > header.n)) {
    const code = r.cells[codeCol] ?? '';
    const qt = qtyCol ? r.cells[qtyCol] ?? '' : '';
    const pt = priceCol ? r.cells[priceCol] ?? '' : '';
    const dt = dateCol ? r.cells[dateCol] ?? '' : '';
    if (blank(code) && blank(qt) && blank(pt) && blank(dt)) continue;
    summary.rowsInSheet += 1;
    if (blank(code)) { problems.push(`Row ${r.n}: there is no item code.`); continue; }
    const k = keyOf(code);
    if (seen.has(k)) { problems.push(`Row ${r.n}: ${code} is also on row ${seen.get(k)} — one row per item.`); continue; }
    seen.set(k, r.n);
    const l = byCode.get(k);
    if (!l) { misses.push({ n: r.n, code }); continue; }
    summary.rowsMatched += 1;
    const set = {};
    const where = `Row ${r.n}: ${code}`;
    if (!blank(qt)) {
      const q = numberCell(qt);
      if (!Number.isFinite(q) || q <= 0) problems.push(`${where} — the quantity is a number above zero ("${qt}" is not).`);
      else if (Math.abs(q - l.quantity) > EPS) { set.quantity = round6(q); changes.push({ action: 'update', path: l.item.code, field: 'Qty', from: l.quantity, to: round6(q) }); }
    }
    if (!blank(pt)) {
      if (pt.trim() === CLEAR) {
        if (l.unitPrice != null) { set.unitPrice = ''; changes.push({ action: 'update', path: l.item.code, field: 'Unit price', from: l.unitPrice, to: null }); }
      } else {
        const v = numberCell(pt);
        if (!Number.isFinite(v) || v < 0) problems.push(`${where} — the unit price is a number, zero or more ("${pt}" is not).`);
        else if (l.unitPrice == null || Math.abs(v - l.unitPrice) > EPS) { set.unitPrice = v; changes.push({ action: 'update', path: l.item.code, field: 'Unit price', from: l.unitPrice, to: v }); }
      }
    }
    if (!blank(dt)) {
      const was = isoOf(l.expectedDate);
      if (dt.trim() === CLEAR) {
        if (was) { set.expectedDate = ''; changes.push({ action: 'update', path: l.item.code, field: 'Expected date', from: was, to: null }); }
      } else {
        const d = readDateText(dt);
        if (!d) problems.push(`${where} — the expected date "${dt}" is not a date (YYYY-MM-DD).`);
        else if (d !== was) { set.expectedDate = d; changes.push({ action: 'update', path: l.item.code, field: 'Expected date', from: was, to: d }); }
      }
    }
    if (Object.keys(set).length) writes.push({ line: l, set }); else summary.unchanged += 1;
  }
  await unmatchedProblems(db, c.companyId, misses, `${p.code} — add it on the screen (Add a line)`, problems);
  const refused = refuseOrReport(args, p.code);
  if (refused) return refused;
  summary.linesChanged = writes.length;
  summary.headerChanged = headerChange ? 1 : 0;
  if (!writes.length && !headerChange) return report({ ...args, summary: { ...summary, sentence: 'nothing to change' } });
  const bits = [];
  if (writes.length) bits.push(`${plural(writes.length, 'line', 'lines')} changed`);
  if (headerChange) bits.push("the PO's expected date changed");
  summary.sentence = bits.join(', ');
  const steps = [];
  if (headerChange) steps.push({ label: 'Expected date', fn: () => updatePurchaseOrder(db, c, p.id, { expectedDate: headDate ?? '' }) });
  for (const w of writes) steps.push({ label: w.line.item.code, fn: () => updatePurchaseLine(db, c, w.line.id, w.set) });
  steps.push({ label: '', fn: () => getPurchaseOrder(db, c.companyId, p.id) });
  const run = await inSavepoint(db, dryRun, steps);
  problems.push(...run.problems);
  const refused2 = refuseOrReport(args, p.code);
  if (refused2) return refused2;
  if (dryRun) return report(args);
  return report({ ...args, applied: true, extra: { purchaseOrder: run.outs.at(-1) } });
}
