/**
 * workbook.js — the ONE build of an Excel file for this app, and the one reader.
 * (TM/CF_HRMS_HIRING_SPEC.md §13.2 and §13.4.)
 *
 * Every entity's file is the same four sheets:
 *
 *   How to use   what the file is, every column in words, the rules
 *   Data         row 1 the headers (frozen, bold); one row per record; hidden
 *                columns A `_id` and B `_seen`; validations on every cell a
 *                person may fill, down to 500 rows past the last record
 *   Lists        the company's own values behind the drop-downs, one column per
 *                list, each a defined name
 *   _meta        hidden: entity, company, schema version, when, and a signature
 *
 * A column is one of:
 *   text | number | date | time     typed by the person, with Excel's own validation
 *   list                            a drop-down fed from the Lists sheet
 *   yesno                           a Yes / No drop-down
 *   issued                          set by the system (a code): grey, locked
 *   info                            read-only context: grey, locked, ignored on upload
 *
 * THE GUARDRAILS IN THE FILE ARE THE FIRST GUARD, NOT THE LAST. Paste goes
 * straight past a validation, and the sheet protection has no password. The
 * reader below therefore trusts nothing: it takes what is in each cell, says
 * exactly what kind of thing it found, and leaves every decision to the engine.
 *
 * Pure with respect to the database: a buffer in, a buffer out.
 */
import crypto from 'crypto';
import ExcelJS from 'exceljs';

export const SCHEMA_VERSION = 1;
export const EXTRA_ROWS = 500;
export const MAX_DATA_ROWS = 2000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const SHEET = { how: 'How to use', data: 'Data', lists: 'Lists', meta: '_meta' };
const ID_HEADER = '_id';
const SEEN_HEADER = '_seen';
const FIRST_COLUMN = 3; // A = _id, B = _seen
const STAR = ' ★';
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4E0F5' } };

const letter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
const pad2 = (n) => String(n).padStart(2, '0');
export const editable = (col) => !['issued', 'info'].includes(col.kind);
export const headerOf = (col) => `${col.header}${col.required ? STAR : ''}`;
const listName = (key) => `List_${key.replace(/[^A-Za-z0-9]/g, '_')}`;

/** The signature of a file's provenance: the server made it, for this entity and this company. */
export function sign(meta) {
  const secret = process.env.JWT_SECRET || process.env.JWT_SECRET_KEY || 'cf_hrms-excel';
  return crypto.createHmac('sha256', secret).update(`${meta.entity}|${meta.companyId}|${meta.schemaVersion}|${meta.generatedAt}|${meta.columns}`).digest('hex').slice(0, 32);
}

const WHAT = {
  text: (c) => `Text${c.max ? `, up to ${c.max} characters` : ''}.`,
  number: (c) => `A ${c.whole === false ? '' : 'whole '}number${c.min != null && c.max != null ? ` from ${c.min} to ${c.max}` : ''}.`,
  date: () => 'A date: a real Excel date, or typed as year-month-day (2026-10-12). 12/10/2026 is refused — nobody can tell the day from the month.',
  time: () => 'A time as HH:MM on the 24-hour clock (08:00, 20:30).',
  list: (c, lists) => `One of the “${lists[c.list]?.label ?? c.list}” list (the Lists sheet). Choose it from the drop-down.`,
  yesno: () => 'Yes or No.',
  issued: () => 'Issued by the system. Leave it as it is; leave it blank for a new row.',
  info: () => 'For reading only. It is ignored when the file is uploaded.',
};

/**
 * @param spec {{
 *   entity, label, fileLabel?, company: { id, name }, userName, intro: string[], rules?: string[],
 *   columns: [{ key, header, kind, required?, list?, max?, min?, whole?, width?, meaning, example? }],
 *   lists: { [key]: { label, values: string[] } },
 *   rows: [{ id, seen, cells: { [key]: string | number | boolean | null } }],
 * }}
 * @returns {Promise<{ fileName, mimeType, buffer }>}
 */
export async function buildWorkbook(spec) {
  const { columns, lists } = spec;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF HRMS';
  wb.created = new Date();
  const how = wb.addWorksheet(SHEET.how);
  const data = wb.addWorksheet(SHEET.data);
  const listSheet = wb.addWorksheet(SHEET.lists);
  const metaSheet = wb.addWorksheet(SHEET.meta, { state: 'veryHidden' });
  const generatedAt = new Date().toISOString();

  // ── Lists: one column per list, a defined name each ───────────────────────
  const used = [...new Set(columns.filter((c) => c.kind === 'list').map((c) => c.list))];
  used.forEach((key, i) => {
    const col = i + 1;
    const values = lists[key]?.values ?? [];
    listSheet.getCell(1, col).value = lists[key]?.label ?? key;
    listSheet.getCell(1, col).font = { bold: true };
    listSheet.getCell(1, col).fill = HEAD;
    values.forEach((v, r) => { listSheet.getCell(r + 2, col).value = v; });
    listSheet.getColumn(col).width = Math.min(60, Math.max(16, ...values.map((v) => String(v).length + 2)));
    // An empty list still gets a name (one blank cell), so the drop-down exists and offers nothing.
    wb.definedNames.add(`${SHEET.lists}!$${letter(col)}$2:$${letter(col)}$${Math.max(2, values.length + 1)}`, listName(key));
  });
  listSheet.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Data ──────────────────────────────────────────────────────────────────
  const last = spec.rows.length + 1 + EXTRA_ROWS;
  data.getCell(1, 1).value = ID_HEADER;
  data.getCell(1, 2).value = SEEN_HEADER;
  data.getColumn(1).hidden = true;
  data.getColumn(2).hidden = true;
  columns.forEach((c, i) => {
    const col = FIRST_COLUMN + i;
    const head = data.getCell(1, col);
    head.value = headerOf(c);
    head.font = { bold: true };
    head.fill = HEAD;
    head.alignment = { vertical: 'middle', wrapText: true };
    const notes = [];
    if (c.required) notes.push('Required.');
    if (c.kind === 'issued') notes.push('Issued by the system — leave as it is; leave blank for a new row.');
    if (c.kind === 'info') notes.push('For reading only — ignored on upload.');
    if (notes.length) head.note = notes.join(' ');
    data.getColumn(col).width = c.width ?? (c.kind === 'list' ? 30 : c.kind === 'date' ? 14 : c.kind === 'yesno' ? 10 : 22);
    if (c.kind === 'date') data.getColumn(col).numFmt = 'yyyy-mm-dd';
    if (c.kind === 'text' || c.kind === 'time' || c.kind === 'list') data.getColumn(col).numFmt = '@';
  });
  data.getRow(1).height = 30;
  data.views = [{ state: 'frozen', ySplit: 1, topLeftCell: `${letter(FIRST_COLUMN)}2`, activeCell: `${letter(FIRST_COLUMN)}2` }];

  spec.rows.forEach((row, r) => {
    const n = r + 2;
    data.getCell(n, 1).value = row.id;
    data.getCell(n, 2).value = row.seen ?? '';
    columns.forEach((c, i) => {
      const v = row.cells[c.key];
      const cell = data.getCell(n, FIRST_COLUMN + i);
      if (v === null || v === undefined || v === '') return;
      if (c.kind === 'date') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
        cell.value = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : String(v);
      } else if (c.kind === 'yesno') cell.value = v === true || v === 'Yes' ? 'Yes' : 'No';
      else cell.value = c.kind === 'number' ? Number(v) : String(v);
    });
  });
  // Locked by default; the cells a person may fill are unlocked, down to the last guarded row.
  for (let n = 2; n <= last; n += 1) {
    columns.forEach((c, i) => {
      const cell = data.getCell(n, FIRST_COLUMN + i);
      if (editable(c)) cell.protection = { locked: false };
      else cell.fill = GREY;
    });
  }
  const rule = (text) => String(text).slice(0, 250);
  columns.forEach((c, i) => {
    const col = letter(FIRST_COLUMN + i);
    const ref = `${col}2:${col}${last}`;
    const base = { allowBlank: true, showErrorMessage: true, errorStyle: 'stop', errorTitle: c.header.slice(0, 30) };
    if (c.kind === 'list') {
      data.dataValidations.add(ref, { ...base, type: 'list', formulae: [`=${listName(c.list)}`], error: rule(`Choose a value from the “${lists[c.list]?.label ?? c.list}” list on the Lists sheet.`) });
    } else if (c.kind === 'yesno') {
      data.dataValidations.add(ref, { ...base, type: 'list', formulae: ['"Yes,No"'], error: 'Yes or No.' });
    } else if (c.kind === 'date') {
      data.dataValidations.add(ref, { ...base, type: 'date', operator: 'between', formulae: [new Date(Date.UTC(1900, 0, 1)), new Date(Date.UTC(2100, 0, 1))], error: 'A date, as 2026-10-12.' });
    } else if (c.kind === 'number') {
      data.dataValidations.add(ref, { ...base, type: c.whole === false ? 'decimal' : 'whole', operator: 'between', formulae: [c.min ?? 0, c.max ?? 1000000], error: rule(`A ${c.whole === false ? '' : 'whole '}number from ${c.min ?? 0} to ${c.max ?? 1000000}.`) });
    } else if (c.kind === 'text' || c.kind === 'time') {
      const max = c.kind === 'time' ? 5 : (c.max ?? 255);
      data.dataValidations.add(ref, { ...base, type: 'textLength', operator: 'lessThanOrEqual', formulae: [max], error: rule(c.kind === 'time' ? 'A time as HH:MM (08:00).' : `Up to ${max} characters.`) });
    }
  });
  // No password: the protection is a guardrail, not security. The server re-checks everything.
  await data.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, sort: true, autoFilter: true });
  await listSheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  // ── _meta ─────────────────────────────────────────────────────────────────
  const meta = { entity: spec.entity, companyId: spec.company.id, schemaVersion: SCHEMA_VERSION, generatedAt, columns: columns.map((c) => c.key).join(',') };
  const metaRows = [...Object.entries(meta), ['generatedBy', spec.userName ?? ''], ['rows', spec.rows.length], ['signature', sign(meta)]];
  metaRows.forEach(([k, v], i) => { metaSheet.getCell(i + 1, 1).value = k; metaSheet.getCell(i + 1, 2).value = String(v); });
  await metaSheet.protect('', {});

  // ── How to use ────────────────────────────────────────────────────────────
  how.getColumn(1).width = 26;
  how.getColumn(2).width = 12;
  how.getColumn(3).width = 70;
  how.getColumn(4).width = 30;
  let n = 1;
  const line = (text, { bold = false, size = 11 } = {}) => {
    how.mergeCells(n, 1, n, 4);
    const cell = how.getCell(n, 1);
    cell.value = text;
    cell.font = { bold, size };
    cell.alignment = { wrapText: true, vertical: 'top' };
    how.getRow(n).height = Math.max(16, Math.ceil(String(text).length / 110) * 16);
    n += 1;
  };
  line(`${spec.label} — ${spec.company.name}`, { bold: true, size: 14 });
  line(`Downloaded on ${generatedAt.slice(0, 10)} by ${spec.userName || 'a user of the app'}, for ${spec.company.name}. ${spec.rows.length} ${spec.rows.length === 1 ? 'row' : 'rows'}.`);
  n += 1;
  for (const t of spec.intro ?? []) line(t);
  n += 1;
  line('The columns of the Data sheet', { bold: true, size: 12 });
  ['Column', 'Required?', 'What goes in it', 'Example'].forEach((h, i) => { const cell = how.getCell(n, i + 1); cell.value = h; cell.font = { bold: true }; cell.fill = HEAD; });
  n += 1;
  for (const c of columns) {
    how.getCell(n, 1).value = c.header;
    how.getCell(n, 2).value = c.required ? 'Yes ★' : (editable(c) ? 'No' : '—');
    how.getCell(n, 3).value = `${c.meaning ? `${c.meaning} ` : ''}${WHAT[c.kind](c, lists)}`;
    how.getCell(n, 4).value = c.example ?? '';
    for (let i = 1; i <= 4; i += 1) how.getCell(n, i).alignment = { wrapText: true, vertical: 'top' };
    n += 1;
  }
  n += 1;
  line('The rules', { bold: true, size: 12 });
  for (const t of [
    'Change a cell to change that record. Add a row at the bottom to add a record: leave the grey cells blank and the system issues its code when you upload.',
    'Uploading never removes anything. A record that is not in the file is left exactly as it is; removing is done on the screen.',
    'Nothing is saved until you have seen the preview: what will be added, what will change, and what is wrong, row by row.',
    'Grey cells are issued by the system or are there for reading only. They are ignored on upload.',
    'Choose list values from the drop-down. A value typed or pasted that is not in the list is refused when you upload.',
    'Dates: a real Excel date, or year-month-day (2026-10-12). Formulas are not read — type the value itself.',
    'If somebody changes a record in the app after you downloaded this file, that row is refused on upload: download a fresh file.',
    'Do not rename the sheets, change the first row, or unhide and edit the hidden columns. This file is for this company only.',
    ...(spec.rules ?? []),
  ]) line(`• ${t}`);
  await how.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  wb.views = [{ x: 0, y: 0, width: 24000, height: 14000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const first = String(spec.company.name ?? 'Company').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '') || 'Company';
  const what = String(spec.fileLabel ?? spec.label).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { fileName: `${first}-${what}-${generatedAt.slice(0, 10)}.xlsx`, mimeType: XLSX_MIME, buffer };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * What is in a cell, said plainly: { kind: 'empty' | 'text' | 'number' | 'date' | 'bool' | 'formula' | 'error', value }.
 * A formula is NEVER evaluated and its cached result is not taken either.
 */
export function cellOf(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return { kind: 'empty', value: null };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { kind: 'error', value: null } : { kind: 'date', value: v };
  if (typeof v === 'number') return { kind: 'number', value: v };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  if (typeof v === 'string') {
    const text = v.replace(/ /g, ' ').trim();
    if (!text) return { kind: 'empty', value: null };
    if (/^=/.test(text)) return { kind: 'formula', value: text };
    return { kind: 'text', value: text };
  }
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return { kind: 'formula', value: String(v.formula ?? v.sharedFormula ?? '') };
    if ('error' in v) return { kind: 'error', value: String(v.error) };
    if (Array.isArray(v.richText)) {
      const text = v.richText.map((p) => p.text ?? '').join('').trim();
      return text ? (/^=/.test(text) ? { kind: 'formula', value: text } : { kind: 'text', value: text }) : { kind: 'empty', value: null };
    }
    if ('text' in v) { const text = String(v.text ?? '').trim(); return text ? { kind: 'text', value: text } : { kind: 'empty', value: null }; }
  }
  return { kind: 'error', value: null };
}

const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/**
 * A cell read as its column says it should be.
 * @returns {{ value: any, entry?: object } | { problem: string }} — value is canonical:
 *   text -> string | null; number -> number | null; date -> 'YYYY-MM-DD' | null; time -> 'HH:MM' | null;
 *   list -> the list entry's text | null (with `entry`); yesno -> 'Yes' | 'No'.
 */
export function readCell(cell, col, lists) {
  const c = cellOf(cell);
  const name = col.header;
  if (c.kind === 'formula') return { problem: `${name} holds a formula (${String(c.value).slice(0, 30)}). Formulas are not read — type the value itself.` };
  if (c.kind === 'error') return { problem: `${name} holds something that cannot be read. Type the value again.` };
  if (c.kind === 'empty') {
    if (col.required) return { problem: `${name} is required.`, empty: true };
    return { value: col.kind === 'yesno' ? 'No' : null };
  }
  switch (col.kind) {
    case 'text': {
      if (c.kind === 'date') return { problem: `${name} is text, and this cell holds a date. Type it as text.` };
      const text = String(c.value);
      if (col.max && text.length > col.max) return { problem: `${name} is ${text.length} characters long; it can be up to ${col.max}.` };
      return { value: text };
    }
    case 'number': {
      const n = c.kind === 'number' ? c.value : (c.kind === 'text' && /^-?\d+(\.\d+)?$/.test(c.value) ? Number(c.value) : NaN);
      if (!Number.isFinite(n)) return { problem: `${name} is a number, and “${String(c.value instanceof Date ? 'a date' : c.value).slice(0, 30)}” is not one.` };
      if (col.whole !== false && !Number.isInteger(n)) return { problem: `${name} is a whole number.` };
      if ((col.min != null && n < col.min) || (col.max != null && n > col.max)) return { problem: `${name} is from ${col.min} to ${col.max}; ${n} is not.` };
      return { value: n };
    }
    case 'date': {
      if (c.kind === 'date') return { value: ymd(c.value) };
      if (c.kind === 'text') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.value);
        const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
        if (d && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])) return { value: c.value };
      }
      return { problem: `${name} is a date, and “${String(c.value).slice(0, 30)}” cannot be read as one for certain. Use a real Excel date, or write it as year-month-day: 2026-10-12.` };
    }
    case 'time': {
      let text = null;
      if (c.kind === 'text') { const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(c.value); if (m && Number(m[1]) < 24 && Number(m[2]) < 60) text = `${pad2(Number(m[1]))}:${m[2]}`; }
      // Excel keeps a time as a date in 1899, or as a fraction of a day.
      if (c.kind === 'date' && c.value.getUTCFullYear() <= 1900) text = `${pad2(c.value.getUTCHours())}:${pad2(c.value.getUTCMinutes())}`;
      if (c.kind === 'number' && c.value >= 0 && c.value < 1) { const mins = Math.round(c.value * 1440); text = `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`; }
      if (!text) return { problem: `${name} is a time as HH:MM (08:00, 20:30), and “${String(c.value instanceof Date ? 'a date' : c.value).slice(0, 30)}” is not one.` };
      return { value: text };
    }
    case 'yesno': {
      const t = c.kind === 'bool' ? (c.value ? 'yes' : 'no') : String(c.value).toLowerCase();
      if (t === 'yes' || t === 'y' || t === 'true') return { value: 'Yes' };
      if (t === 'no' || t === 'n' || t === 'false') return { value: 'No' };
      return { problem: `${name} is Yes or No, and “${String(c.value).slice(0, 30)}” is neither.` };
    }
    case 'list': {
      if (c.kind === 'date') return { problem: `${name} is chosen from the list, and this cell holds a date.` };
      const text = String(c.value);
      const list = lists[col.list];
      const key = text.split(' — ')[0].trim().toLowerCase();
      const entry = list?.byKey.get(key) ?? list?.byKey.get(text.toLowerCase()) ?? null;
      // A lenient list is read as typed: its entity resolves it, to say WHY a value cannot be taken.
      if (!entry && col.lenient) return { value: text };
      if (!entry) return { problem: `${name}: “${text.slice(0, 60)}” is not in the “${list?.label ?? col.list}” list. Choose a value from the drop-down (the Lists sheet has them all).` };
      return { value: entry.text, entry };
    }
    default:
      return { value: null };
  }
}

/**
 * Opens an uploaded file. Never throws for a bad file — it says what is wrong.
 *
 * @returns {Promise<{ fileProblems: string[], meta: object | null, columnAt: Map<string, number>, rows: [{ row, id, seen, cell(key) }] , dataRowCount }>}
 *   `columnAt`: header text (without the star) -> column number on the Data sheet.
 */
export async function openWorkbook(buffer, fileName = '') {
  const out = { fileProblems: [], meta: null, columnAt: new Map(), sheet: null, lastRow: 0 };
  const name = String(fileName ?? '').toLowerCase();
  if (/\.xlsm$/.test(name) || /\.xlsb$/.test(name) || /\.xls$/.test(name)) {
    out.fileProblems.push('This is not an .xlsx file. A workbook with macros (.xlsm) or in the old format (.xls) is not read — download a fresh file from the app.');
    return out;
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) { out.fileProblems.push('No file was received.'); return out; }
  if (buffer.length > MAX_FILE_BYTES) { out.fileProblems.push(`The file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. A file of up to 5 MB is read; this app’s own files are far smaller.`); return out; }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) { out.fileProblems.push('This is not an Excel workbook (.xlsx). Download a fresh file from the app and fill that in.'); return out; }
  // A macro-enabled workbook saved under an .xlsx name still carries its macro project.
  if (buffer.includes(Buffer.from('vbaProject.bin'))) { out.fileProblems.push('This workbook carries macros. It is not read — download a fresh file from the app.'); return out; }
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { out.fileProblems.push('This file could not be opened as an Excel workbook (.xlsx). Download a fresh file from the app.'); return out; }

  const metaSheet = wb.getWorksheet(SHEET.meta);
  const data = wb.getWorksheet(SHEET.data);
  if (!metaSheet || !data) {
    out.fileProblems.push(`This is not a workbook from this app${!data && metaSheet ? ': its Data sheet is missing' : ''}. Download a fresh file and fill that in.`);
    return out;
  }
  const meta = {};
  metaSheet.eachRow((row) => { const k = cellOf(row.getCell(1)).value; if (k) meta[String(k)] = String(cellOf(row.getCell(2)).value ?? ''); });
  out.meta = meta;
  const signed = { entity: meta.entity, companyId: meta.companyId, schemaVersion: meta.schemaVersion, generatedAt: meta.generatedAt, columns: meta.columns };
  out.signatureOk = Boolean(meta.signature) && meta.signature === sign(signed);

  if (cellOf(data.getCell(1, 1)).value !== ID_HEADER || cellOf(data.getCell(1, 2)).value !== SEEN_HEADER) {
    out.fileProblems.push('The hidden columns of the Data sheet have been moved or removed. Download a fresh file and fill that in.');
    return out;
  }
  const headRow = data.getRow(1);
  for (let col = FIRST_COLUMN; col <= Math.max(data.columnCount, FIRST_COLUMN); col += 1) {
    const h = cellOf(headRow.getCell(col));
    if (h.kind === 'text') out.columnAt.set(h.value.replace(/\s*★\s*$/, '').trim(), col);
  }
  out.sheet = data;
  out.lastRow = data.rowCount;
  return out;
}

export default { SCHEMA_VERSION, EXTRA_ROWS, MAX_DATA_ROWS, MAX_FILE_BYTES, XLSX_MIME, SHEET, buildWorkbook, openWorkbook, readCell, cellOf, headerOf, editable };
