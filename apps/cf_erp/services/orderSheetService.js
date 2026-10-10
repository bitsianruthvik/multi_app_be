/**
 * orderSheetService.js — a sales order line's BOM as a spreadsheet: THE SCREEN,
 * TWO ROWS PER LINE.
 *
 * User, 2026-10-10: "For each order line, have two rows in excel — one row will
 * have the field name and the following row is for filling the value. Remove
 * anything unnecessary. It should just be the entire BOM as seen in the UI with
 * just 2 rows per line instead of 1." and "at every stage the excel that is
 * getting downloaded is always having the latest list of fields."
 *
 * So this sheet is not a table with one column per specification (that is
 * bomSheetService, which a catalog item's or definition's BOM still uses). It
 * is the Structure tab, row for row:
 *
 *   row 1            one sentence saying how to read the sheet (frozen)
 *   then, for every row the screen draws, in the screen's order, a PAIR:
 *     names row      A: the row's code / placeholder     B…: the name of each of ITS fields
 *     values row     A: the row's name (· role), indented B…: the value under each name
 *
 * WHICH rows, WHICH fields, in WHAT order and with WHAT text is not decided
 * here: lib/orderSheetLayout.js is the one rule, a mirror of the frontend's
 * grid rules that a test holds to them. It is worked out afresh on every
 * download from the line's structure and its values view — nothing is cached,
 * nothing is remembered from the last download — so a field that starts or
 * stops applying to a row is in or out of the very next sheet.
 *
 * WHAT IDENTIFIES A PAIR
 * Not its position. One hidden column, at the far right, carries on both rows
 * of a pair `N|<place>` / `V|<place>`, where <place> is the BOM line id (ROOT
 * for what the line sells) and the record it holds. A sorted or filtered sheet
 * still reads back; a pair that is left out is simply not mentioned.
 *
 * WHAT MAY BE CHANGED
 * Exactly what the screen lets a person type, by the screen's own rules:
 *   a value   -> orderValuesService.writeLineValues, the Values grid's own save
 *   a Qty     -> bomService.writeLineUpdate, edit mode's own line update
 * Flow, Total and every worked-out cell are grey and refused in words. So is a
 * changed field name, a pair this line does not have, a pair without its row of
 * values. Rows are neither added nor removed here — that is the screen's.
 *
 * "Unchanged" means unchanged: a cell is compared with exactly what a download
 * would write in it now, so a default that is only SHOWN and left alone is not
 * turned into a typed value.
 *
 * ROUND TRIPS (production is ~49 ms a hop)
 *   download  readLineValues (8) + explode (3 + one per level) + placeholders
 *   upload    the same reads, then at most one writeLineValues for every value
 *             in the sheet and, per changed quantity, one writeLineUpdate with
 *             one refresh for all of them.
 */
import ExcelJS from 'exceljs';
import { CfError, invalid, conflict, assertNoProblems } from '../lib/errors.js';
import { requireMaster } from './records.js';
import { explode, writeLineUpdate, assertEditable } from './bomService.js';
import { refreshValues } from './valueService.js';
import { dateText } from './resolutionService.js';
import { readLineValues, writeLineValues } from './orderValuesService.js';
import { linePlaceholders } from './placeholderService.js';
import { orderSheetLayout, placeholderKey } from '../lib/orderSheetLayout.js';

export const SHEET_NAME = 'BOM';
/** Long pick-lists live here (Excel takes at most 255 characters inline); never shown. */
const LISTS_SHEET = '_lists';
const MAX_PAIRS = 20000;
const ID_RE = /^([NV])\|((?:ROOT|\d+(?:#\d+)?):\d+)$/;

export const BANNER = 'The grey row above each line names its fields — type in the white cells under them; grey cells are worked out, amber cells still need a value.';

const GREY_NAMES = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const AMBER = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0A3' } };
const EDGE = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };

const blank = (v) => v == null || String(v).trim() === '';
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const isNumberText = (s) => !blank(s) && Number.isFinite(Number(String(s).trim()));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One cell of an ExcelJS sheet as plain text: formulas, rich text and dates all flattened. */
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return dateText(v) ?? '';
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

/** Two cell texts that say the same thing: the same text, or the same number written two ways. */
const sameText = (a, b) => {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (x === y) return true;
  return isNumberText(x) && isNumberText(y) && near(x, y);
};

/* ===========================================================================
 * The live picture — what the screen shows right now
 * ======================================================================== */

/**
 * The line's layout, read fresh: the values view (which also says whether the
 * line is still open), the structure, and the placeholder codes. A sheet
 * without placeholders is still a sheet, so a roll-out that cannot be worked
 * out yet leaves those cells empty rather than failing the download.
 */
async function loadLayout(db, companyId, lineId) {
  const view = await readLineValues(db, companyId, lineId);
  const [tree, placeholders] = await Promise.all([
    explode(db, companyId, view.root.id, { rootQuantity: view.line.quantity }),
    linePlaceholders(db, companyId, lineId).catch(() => null),
  ]);
  const codes = new Map();
  for (const r of placeholders?.rows ?? []) if (r.code) codes.set(placeholderKey(r.bomLineId, r.itemId), r.code);
  const rows = orderSheetLayout({ root: tree.root, view, codes });
  return { view, tree, rows };
}

/** The fields a pair is written with — a dimension the row does not have is left out. */
const sheetFields = (row) => row.fields.filter((f) => f.kind !== 'na');

/** What a download writes in a field's cell. A number that reads as one is a number, so Excel treats it as one. */
function cellValueOf(f) {
  if (f.value === '') return null;
  const numeric = f.kind === 'quantity' || f.kind === 'total' || (f.kind === 'value' && f.dataType === 'number' && f.state === 'typed');
  if (numeric && isNumberText(f.value) && String(Number(f.value)) === f.value) return Number(f.value);
  return f.value;
}

/* ===========================================================================
 * Download
 * ======================================================================== */

/** GET /order-lines/:id/sheet -> { buffer, filename, contentType, rows } — `rows` is the BOM rows written (two sheet rows each). */
export async function exportOrderSheet(db, companyId, lineId) {
  const { view, rows } = await loadLayout(db, companyId, lineId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  const widest = rows.reduce((n, r) => Math.max(n, sheetFields(r).length), 0);
  const idCol = widest + 2;
  // Each column as wide as the longest name or value that lands in it (the names are small print), within reason.
  const widths = Array.from({ length: widest }, () => 12);
  for (const r of rows) sheetFields(r).forEach((f, i) => { widths[i] = Math.min(34, Math.max(widths[i], Math.ceil(f.label.length * 0.85) + 2, f.value.length + 3)); });
  ws.columns = [{ width: 46 }, ...widths.map((width) => ({ width })), { width: 18, hidden: true }];

  const banner = ws.addRow([view.lock ? `${view.lock.message} This sheet is a record — it cannot be uploaded.` : BANNER]);
  banner.font = { italic: true, color: { argb: 'FF595959' } };
  banner.height = 20;

  // A pick-list too long (or too awkward) to write inline is kept on a sheet nobody sees.
  let lists = null;
  const listRefs = new Map();
  const listFormula = (texts) => {
    const inline = texts.join(',');
    if (inline.length <= 250 && texts.every((t) => !/[",]/.test(t))) return `"${inline}"`;
    const sig = texts.join('\u0001');
    if (!listRefs.has(sig)) {
      if (!lists) { lists = wb.addWorksheet(LISTS_SHEET); lists.state = 'veryHidden'; }
      const colNo = listRefs.size + 1;
      texts.forEach((t, i) => { lists.getCell(i + 1, colNo).value = t; });
      const letter = lists.getColumn(colNo).letter;
      listRefs.set(sig, `'${LISTS_SHEET}'!$${letter}$1:$${letter}$${texts.length}`);
    }
    return listRefs.get(sig);
  };

  for (const row of rows) {
    const fields = sheetFields(row);
    const names = ws.addRow([row.code || null, ...fields.map((f) => f.label)]);
    const values = ws.addRow([row.label, ...fields.map(cellValueOf)]);
    names.getCell(idCol).value = `N|${row.id}`;
    values.getCell(idCol).value = `V|${row.id}`;
    names.height = 13;
    for (let i = 1; i <= fields.length + 1; i++) {
      const c = names.getCell(i);
      c.fill = GREY_NAMES;
      c.font = { bold: true, size: 8, color: { argb: 'FF404040' } };
      c.alignment = { vertical: 'middle', indent: i === 1 ? Math.min(row.depth, 12) : 0 };
    }
    const head = values.getCell(1);
    head.alignment = { indent: Math.min(row.depth, 12) };
    head.font = { bold: row.depth === 0 };
    fields.forEach((f, i) => {
      const c = values.getCell(i + 2);
      c.border = BOX;
      if (!f.editable) { c.fill = GREY; return; }
      if (f.kind === 'value' && f.missing) c.fill = AMBER;
      // A default that is only shown is not the row's own value: it reads as one.
      if (f.kind === 'value' && f.state === 'default') c.font = { italic: true, color: { argb: 'FF7F7F7F' } };
      if (f.kind === 'quantity') {
        c.numFmt = '0.######';
        c.dataValidation = { type: 'decimal', operator: 'greaterThan', formulae: [0], allowBlank: false, showErrorMessage: true, error: 'A quantity is a number above zero.' };
      } else if (f.dataType === 'option' && f.options?.length) {
        c.dataValidation = { type: 'list', allowBlank: true, formulae: [listFormula(f.options.map((o) => o.text))], showErrorMessage: true, error: `Choose one of the choices of ${f.name}.` };
      } else if (f.dataType === 'boolean') {
        c.dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: true, error: 'Yes or No.' };
      } else if (f.dataType === 'number') {
        c.dataValidation = { type: 'decimal', operator: 'between', formulae: [-1e15, 1e15], allowBlank: true, showErrorMessage: true, error: `${f.name} is a number.` };
      }
    });
  }

  const stem = `BOM_${view.order.code}_L${view.line.lineNo}`.replace(/[^\w.-]+/g, '_');
  return {
    filename: `${stem}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    rows: rows.length,
  };
}

/* ===========================================================================
 * Upload
 * ======================================================================== */

const looksXlsx = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

/** The sheet as { sheetRow, cells[] (1-based column -> text), tag, id } for every row that carries a pair id. */
async function readPairs(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid('BAD_FILE', 'That file could not be opened as an Excel workbook. Upload the .xlsx this line’s Download gave you.'); }
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets.find((w) => w.name !== LISTS_SHEET) ?? wb.worksheets[0];
  if (!ws) throw invalid('EMPTY_SHEET', 'That workbook has no sheets in it.');
  const tagged = [];
  let other = 0;
  ws.eachRow({ includeEmpty: false }, (row, sheetRow) => {
    const cells = [];
    const n = Math.max(row.cellCount, row.actualCellCount);
    let tag = null;
    let idAt = 0;
    for (let i = 1; i <= n; i++) {
      const t = cellText(row.getCell(i).value);
      cells[i] = t;
      const m = ID_RE.exec(t);
      if (m) { tag = m; idAt = i; }
    }
    if (!tag) { if (sheetRow > 1 && cells.some((t) => t)) other += 1; return; }
    cells[idAt] = '';
    tagged.push({ sheetRow, cells, kind: tag[1], id: tag[2] });
  });
  return { tagged, other };
}

const sentenceOf = (s) => {
  const bits = [];
  if (s.quantityChanged) bits.push(plural(s.quantityChanged, 'quantity changed', 'quantities changed'));
  if (s.valuesChanged) bits.push(plural(s.valuesChanged, 'value changed', 'values changed'));
  return bits.length ? bits.join(', ') : 'nothing to change';
};

/** A typed cell as writeLineValues takes it: null clears; a pick-list answers with its option's id. */
function inputFor(f, text, problems, where) {
  const t = String(text ?? '').trim();
  if (t === '') return { input: '', value: null };
  if (f.dataType === 'option') {
    const lower = t.toLowerCase();
    const found = (f.options ?? []).find((o) => o.text === t) ?? (f.options ?? []).find((o) => o.text.toLowerCase() === lower);
    if (!found) {
      const choices = (f.options ?? []).map((o) => o.text);
      problems.push(`${where}: "${t}" is not one of the choices of ${f.label}${choices.length ? ` — ${choices.slice(0, 8).join(', ')}${choices.length > 8 ? '…' : ''}` : ''}.`);
      return null;
    }
    return { input: String(found.id), value: String(found.id) };
  }
  if (f.dataType === 'boolean') {
    const lower = t.toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(lower)) return { input: 'true', value: 'true' };
    if (['no', 'n', 'false', '0'].includes(lower)) return { input: 'false', value: 'false' };
    problems.push(`${where}: ${f.label} is Yes or No — "${t}" is neither.`);
    return null;
  }
  return { input: t, value: t };
}

/**
 * POST /order-lines/:id/sheet — { fileBase64, dryRun? }. Needs a transaction.
 * A dry run reports the plan and its problems and writes nothing; applying
 * refuses the whole sheet if anything in it is wrong.
 */
export async function importOrderSheet(db, c, lineId, input = {}) {
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';
  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to import — send the file as `fileBase64`.');
  let buffer;
  try {
    buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64');
  } catch {
    throw invalid('BAD_FILE', 'That file could not be read — send it as base64.');
  }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');

  const { view, rows } = await loadLayout(db, c.companyId, lineId);
  // One rule for "this structure can still change" (bomService.assertEditable),
  // asked before the file is even opened — in the line's own locked words.
  await assertEditable(db, c.companyId, await requireMaster(db, c.companyId, view.root.id));
  if (view.lock) throw conflict(view.lock.reason === 'released' ? 'RELEASED' : view.lock.reason === 'locked' ? 'LOCKED' : 'ORDER_CLOSED', view.lock.message);
  if (!looksXlsx(buffer)) throw invalid('BAD_FILE', 'That is not an Excel workbook. Upload the .xlsx this line’s Download gave you.');

  const { tagged, other } = await readPairs(buffer);
  const problems = [];
  const changes = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const head = {
    orderLine: { id: view.line.id, lineNo: view.line.lineNo, quantity: view.line.quantity },
    order: { id: view.order.id, code: view.order.code, status: view.order.status },
    root: { id: view.root.id, code: view.root.code, name: view.root.name },
    format: 'xlsx',
    dryRun,
  };
  const report = (summary) => ({ ...head, ok: problems.length === 0, problems, changes, summary: { ...summary, roleChanged: 0, notesChanged: 0, rowsAdded: 0, rowsRemoved: 0, rowsRemovedBeneath: 0, sentence: summary.sentence ?? sentenceOf(summary) } });
  const nothing = (sentence) => report({ rowsInSheet: 0, rowsMatched: 0, quantityChanged: 0, valuesChanged: 0, unchanged: 0, sentence });

  if (!tagged.length) {
    problems.push(other
      ? 'This is not a sheet downloaded from this order line (its hidden line ids are missing). Download the sheet again and change that copy.'
      : 'That sheet has no BOM lines in it. Download the sheet again and change that copy.');
    if (dryRun) return nothing('nothing — this sheet does not match this order line');
    assertNoProblems(problems, 'That sheet was not applied — 1 problem to fix first.');
  }

  // ---- the pairs, by their hidden id ---------------------------------------
  const pairs = new Map();
  for (const t of tagged) {
    if (!pairs.has(t.id)) pairs.set(t.id, { id: t.id, names: [], values: [] });
    pairs.get(t.id)[t.kind === 'N' ? 'names' : 'values'].push(t);
  }
  if (pairs.size > MAX_PAIRS) throw invalid('TOO_BIG', `A sheet of more than ${MAX_PAIRS} lines is more than this import will take in one go.`);

  const matched = [];
  for (const p of pairs.values()) {
    const at = (p.values[0] ?? p.names[0]).sheetRow;
    const said = p.values[0]?.cells[1] || p.names[0]?.cells[1] || '';
    const row = byId.get(p.id);
    if (!row) {
      problems.push(`Sheet row ${at}${said ? ` (${said})` : ''}: this line is not part of the structure any more, or its hidden id was changed. Download the sheet again and redo the change.`);
      continue;
    }
    if (p.names.length > 1 || p.values.length > 1) {
      problems.push(`${row.label} is in the sheet more than once (sheet rows ${[...p.names, ...p.values].map((x) => x.sheetRow).sort((a, b) => a - b).join(', ')}). Keep one pair of rows for it.`);
      continue;
    }
    if (!p.values.length) { problems.push(`${row.label} (sheet row ${at}): the row of values under its names is missing. Download the sheet again.`); continue; }
    if (!p.names.length) { problems.push(`${row.label} (sheet row ${at}): the grey row of names above its values is missing. Download the sheet again.`); continue; }
    matched.push({ row, names: p.names[0], values: p.values[0] });
  }

  // ---- every cell against what a download would write now -------------------
  const qtyPlan = new Map();   // lineId -> { row, from, to, said: [{ label, text }] }
  const valuePlan = new Map(); // recordId:code -> { recordId, code, f, row, value, input, from, to }
  const saidValue = new Map(); // recordId:code -> [{ row, text }]  (a record in several places must agree)
  const touched = new Set();
  for (const { row, names, values } of matched) {
    const where = row.label;
    const fields = sheetFields(row);
    const byLabel = new Map(fields.map((f) => [f.label, f]));
    const expectedHead = { names: row.code || '', values: row.label };
    if (!sameText(names.cells[1], expectedHead.names)) problems.push(`${where}: its code (${expectedHead.names || 'empty'}) was changed to "${names.cells[1] ?? ''}". A code is given by the system — it is not typed in this sheet.`);
    if (!sameText(values.cells[1], expectedHead.values)) problems.push(`${where}: its name was changed to "${values.cells[1] ?? ''}". A row is renamed on the screen, not in this sheet.`);

    const width = Math.max(names.cells.length, values.cells.length);
    const seenLabels = new Set();
    for (let col = 2; col < width; col++) {
      const label = names.cells[col] ?? '';
      const text = values.cells[col] ?? '';
      if (label === '') {
        if (text !== '') problems.push(`${where}: "${text}" sits under no field name (sheet row ${values.sheetRow}). Type only under a name in the grey row.`);
        continue;
      }
      const f = byLabel.get(label);
      if (!f) {
        problems.push(`${where}: "${label}" is not one of this line’s fields — a name in the grey row was changed, or the field no longer applies. Download the sheet again; the names are not typed.`);
        continue;
      }
      if (seenLabels.has(label)) { problems.push(`${where}: "${label}" is named twice in its grey row. Download the sheet again.`); continue; }
      seenLabels.add(label);

      if (f.kind === 'value') {
        const k = `${row.nodeId}:${f.code}`;
        if (!saidValue.has(k)) saidValue.set(k, []);
        saidValue.get(k).push({ row, text, label });
      }
      if (sameText(text, f.value)) continue;

      if (f.kind === 'total') { problems.push(`${where}: Total (${f.value}) was changed to "${text}". ${f.why} Change Qty instead.`); continue; }
      if (f.kind === 'flow') { problems.push(`${where}: Flow (${f.value || 'none'}) was changed to "${text}". ${f.why}`); continue; }
      if (f.kind === 'quantity') {
        if (!f.editable) { problems.push(`${where}: Qty (${f.value}) was changed to "${text}". ${f.why}`); continue; }
        const q = Number(text);
        if (blank(text)) { problems.push(`${where}: Qty is empty. Every row needs a quantity.`); continue; }
        if (!Number.isFinite(q) || q <= 0) { problems.push(`${where}: "${text}" is not a quantity — it must be a number above zero.`); continue; }
        if (q >= 1e9) { problems.push(`${where}: that quantity is too large.`); continue; }
        const to = Number(q.toFixed(6));
        const old = qtyPlan.get(row.lineId);
        if (old && !near(old.to, to)) {
          problems.push(`${where} sits in ${plural(2, 'place', 'places')} of this structure and is one row in the system — its Qty is given as ${old.to} and as ${to}. Give every copy the same quantity.`);
          continue;
        }
        qtyPlan.set(row.lineId, { row, from: Number(f.value), to });
        touched.add(row.id);
        continue;
      }
      // A value.
      if (!f.editable) {
        problems.push(`${where}: ${f.label} (${f.value || 'empty'}) was changed to "${text}", but it is ${f.state === 'worked' ? 'worked out, not typed' : 'not typed here'}${f.why ? ` — ${f.why}` : '.'}`);
        continue;
      }
      const typed = inputFor(f, text, problems, where);
      if (!typed) continue;
      // The cell showed a default (or nothing) and now holds what the row already has of its own: nothing to do.
      if (typed.input === f.input || (f.dataType === 'number' && typed.input !== '' && f.input !== '' && isNumberText(typed.input) && near(typed.input, f.input))) continue;
      const k = `${row.nodeId}:${f.code}`;
      if (!valuePlan.has(k)) valuePlan.set(k, { recordId: row.nodeId, code: f.code, f, row, value: typed.value, from: f.value === '' ? null : f.value, to: blank(text) ? null : String(text).trim(), rows: [row.id] });
      else valuePlan.get(k).rows.push(row.id);
    }
  }
  // A record that sits in several places is ONE record: its places must say the same thing.
  for (const [k, said] of saidValue) {
    if (said.length < 2) continue;
    const first = said[0];
    const odd = said.find((s) => !sameText(s.text, first.text));
    if (!odd) continue;
    problems.push(`${first.row.name} sits in ${said.length} places of this structure and is one record — ${first.label} is given as "${first.text}" (${first.row.code || first.row.label}, under sheet id ${first.row.id}) and as "${odd.text}" (${odd.row.code || odd.row.label}, under sheet id ${odd.row.id}). Give every place the same value.`);
    valuePlan.delete(k);
  }

  // ---- values: the Values grid's own save decides, in its own words ---------
  // It checks everything before it writes anything, and a dry run of it is the
  // real write inside a savepoint, rolled back — so a preview reports exactly
  // what applying would do, and refuse. When applying, this IS the write: it
  // goes first because it is all-or-nothing by itself, and it only runs when
  // nothing else in the sheet is wrong.
  const writes = [...valuePlan.values()].map((v) => ({ recordId: v.recordId, specCode: v.code, value: v.value }));
  let valuesOut = null;
  if (writes.length && (dryRun || !problems.length)) {
    try {
      valuesOut = await writeLineValues(db, c, lineId, { dryRun, writes });
    } catch (e) {
      if (!(e instanceof CfError) || !Array.isArray(e.problems) || !e.problems.length) throw e;
      problems.push(...e.problems);
    }
  }
  // Only what the save itself counts as a change is one ("10.0" over 10 is not).
  const reallyChanged = valuesOut ? new Set(valuesOut.changes.map((ch) => `${ch.recordId}:${String(ch.specCode).toUpperCase()}`)) : null;
  for (const [k, v] of valuePlan) {
    if (reallyChanged && !reallyChanged.has(`${v.recordId}:${String(v.code).toUpperCase()}`)) { valuePlan.delete(k); continue; }
    for (const id of v.rows) touched.add(id);
    changes.push({ action: 'value', field: v.f.label, rowId: v.row.id, path: v.row.label, from: v.from, to: v.to });
  }
  for (const [lineIdOfRow, q] of qtyPlan) {
    changes.push({ action: 'update', field: 'quantity', rowId: q.row.id, path: q.row.label, from: q.from, to: q.to, lineId: lineIdOfRow });
  }
  // Quantities first in the list a person reads — structure before values, as on the screen.
  changes.sort((a, b) => Number(b.action === 'update') - Number(a.action === 'update'));

  const summary = {
    rowsInSheet: pairs.size,
    rowsMatched: matched.length,
    quantityChanged: qtyPlan.size,
    valuesChanged: valuePlan.size,
    unchanged: matched.filter((m) => !touched.has(m.row.id)).length,
  };
  if (problems.length) {
    // A sheet with a problem applies nothing, so it promises nothing either.
    changes.length = 0;
    if (dryRun) return report({ ...summary, quantityChanged: 0, valuesChanged: 0, sentence: 'nothing — fix the sheet first' });
    assertNoProblems(problems, `That sheet was not applied — ${plural(problems.length, 'problem', 'problems')} to fix first.`);
  }
  if (dryRun) return report(summary);

  // ---- apply: the values are in (above); now the quantities, with ONE refresh
  // of what they roll up into for all of them.
  const refreshParents = new Set();
  for (const [lineIdOfRow, q] of qtyPlan) {
    const changed = await writeLineUpdate(db, c, lineIdOfRow, { quantity: q.to });
    if (changed.values) refreshParents.add(changed.parentId);
  }
  if (refreshParents.size) await refreshValues(db, c, [...refreshParents]);
  return { ...report(summary), applied: true };
}
