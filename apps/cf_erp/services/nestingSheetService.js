/**
 * nestingSheetService.js — a line's nests as a spreadsheet, out and back in,
 * at QUANTITY level.
 *
 * WHY IT CHANGED (decided 2026-09-29, CF_ERP_NESTING_PLAN last section). The
 * user: people often nest in ANOTHER program and get a plan of several nests,
 * each ONE standard plate plus the cut plates on it with quantities. So the
 * sheet no longer carries x/y per piece; it carries what that program hands
 * out:
 *
 *   Nest | Plate | Cut plate | Qty | Grade   (then read-only Verdict, Notes)
 *
 * one row per cut plate on a nest. A nest is one physical plate.
 *
 * MATCHING IS FORGIVING, BECAUSE THE OTHER PROGRAM'S NAMES ARE NOT OURS.
 *   Plate      a catalog plate code, or its size "T x L x W" (12 x 2500 x 1250).
 *   Cut plate  our code, or its size "T x L x W", with the Grade column to tell
 *              two same-size cut plates of different steel apart.
 * Spaces, "x" / "X" / "×" / "*", a trailing "mm" and thousands separators
 * ("2,500") are all read. A size that matches nothing, or more than one thing,
 * is a cell problem that says so.
 *
 * CHECKED, NOT REFUSED. Every nest is checked with our packer on its own plate
 * (nestingService.checkNest): fits / tight / wont_fit, with reasons in plain
 * sentences. The user may save a nest that does not fit — "Save anyway" — and
 * the lot records that it was forced. What DOES block a save is a cell that
 * cannot be read (an unknown code, a quantity that is not a whole number).
 *
 * COVERAGE. The upload need not cover the whole line: import some, let us nest
 * the rest. Short is fine. OVER (more pieces than the line needs) needs force,
 * like a verdict that is not `fits`.
 *
 * SAVING REPLACES EVERY LOT ON THE LINE — imported and automatic alike; the
 * rest is nested again afterwards ("Nest the rest"). The workbook says so on
 * its own face, and the preview says so before anything is written. A dry run
 * writes nothing at all (no savepoint trick is needed any more: the check is
 * read-only and the save is a separate call).
 */
import ExcelJS from 'exceljs';
import { invalid } from '../lib/errors.js';
import {
  getNesting, importContext, importBlocker, checkImportedNests, saveImportedNests,
  NEST_MANUAL_SPEC_CODE,
} from './nestingService.js';

export const NESTS_SHEET = 'Nests';
export const NEEDED_SHEET = 'Needed';
export const NOTES_SHEET = 'How to use this';

/** More rows than this is not something one upload should take. */
const MAX_ROWS = 20000;
/** How far down the header row may hide before we give up looking. */
const HEADER_SEARCH_ROWS = 12;

export const BANNER = 'SAVING AN UPLOAD REPLACES EVERY NEST ON THIS LINE — imported and automatic alike. '
  + 'Upload shows a preview first: each nest checked against our cutting rules, and what is short or over. '
  + 'Nothing is written until you press Save.';

/* ---------------------------------------------------------------------------
 * Columns. `readOnly` columns are written for information and never read back.
 * ------------------------------------------------------------------------ */
const RO = ' [not read back]';
export const NEST_COLUMNS = [
  { key: 'nest', header: 'Nest', width: 12 },
  { key: 'plate', header: 'Plate', width: 26 },
  { key: 'cutPlate', header: 'Cut plate', width: 30 },
  { key: 'qty', header: 'Qty', width: 8 },
  { key: 'grade', header: 'Grade', width: 12 },
  { key: 'verdict', header: 'Verdict', width: 12, readOnly: true },
  { key: 'notes', header: 'Notes', width: 70, readOnly: true },
];
const NEEDED_COLUMNS = [
  { header: 'Cut plate', width: 30 },
  { header: 'Thickness (mm)', width: 14 },
  { header: 'Length (mm)', width: 13 },
  { header: 'Width (mm)', width: 13 },
  { header: 'Grade', width: 12 },
  { header: 'Needed', width: 10 },
  { header: 'Nested', width: 10 },
  { header: 'Left', width: 10 },
];

/** Header words each column answers to — the other program's names too. */
const ALIASES = {
  nest: ['NEST', 'NEST NO', 'NEST NUMBER', 'NEST #', 'NEST ID', 'NEST NAME', 'SHEET', 'SHEET NO', 'LOT', 'PROGRAM'],
  plate: ['PLATE', 'PLATE CODE', 'RAW PLATE', 'STOCK PLATE', 'PLATE SIZE', 'RM PLATE', 'STOCK'],
  cutPlate: ['CUT PLATE', 'CUT PLATE CODE', 'CUT PIECE', 'PART', 'PART CODE', 'PART NAME', 'BLANK', 'ITEM'],
  qty: ['QTY', 'QUANTITY', 'NOS', 'NO', 'COUNT', 'PCS', 'PIECES'],
  grade: ['GRADE', 'MATERIAL GRADE', 'STEEL GRADE'],
};

/** `Cut plate (mm) [not read back]` -> CUT PLATE. Brackets carry units and warnings. */
export const normaliseHeader = (h) => String(h ?? '').split(/[([]/)[0].replace(/[._:]+$/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const HEADER_KEY = new Map(Object.entries(ALIASES).flatMap(([key, names]) => names.map((n) => [n, key])));

/* --- small helpers -------------------------------------------------------- */
const blank = (v) => v == null || String(v).trim() === '';
const round3 = (n) => Number(Number(n).toFixed(3));
const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : String(round3(n)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** A code as typed: trimmed, runs of spaces made one, case ignored. */
export const normCode = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const squash = (s) => normCode(s).replace(/\s+/g, '');
const normGrade = (s) => (blank(s) ? null : squash(s));

/**
 * A number as people type it: "2500", "2,500", "2 500", "12.5", "12,5" (a
 * decimal comma), "12mm". NaN when it is not one.
 */
export function parseNumber(raw) {
  if (typeof raw === 'number') return raw;
  let s = String(raw ?? '').trim().toLowerCase().replace(/mm$/, '').replace(/\s+/g, '');
  if (s === '') return NaN;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
  return /^[-+]?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
}

/** "12 x 2500 x 1250", "12×2500×1250", "12*2,500*1,250 mm" -> [12, 2500, 1250], else null. */
export function parseSize(raw) {
  if (blank(raw) || typeof raw === 'number') return null;
  const s = String(raw).toLowerCase().replace(/mm/g, ' ').replace(/[×*]/g, 'x').trim();
  const parts = s.split(/\s*x\s*/).filter((p) => p !== '');
  if (parts.length !== 3) return null;
  const nums = parts.map(parseNumber);
  return nums.every((n) => Number.isFinite(n) && n > 0) ? nums : null;
}

const sameSize = (a, b, tol = 0.5) => Math.abs(Number(a) - Number(b)) <= tol;
const sizeMatches = (steel, [t, l, w]) => sameSize(steel.thickness, t, 0.01)
  && ((sameSize(steel.length, l) && sameSize(steel.width, w)) || (sameSize(steel.length, w) && sameSize(steel.width, l)));
const sizeText = (s) => `${fmt(s.thickness)} x ${fmt(s.length)} x ${fmt(s.width)}`;

/** One ExcelJS cell as plain text (or a number): formulas, rich text and dates flattened. */
function cellValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim() || null;
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* ===========================================================================
 * Out
 * ======================================================================== */

const VERDICT_WORD = { fits: 'Fits', tight: 'Tight', wont_fit: "Won't fit" };
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
const HEAD_RO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDDDDD' } };
const BANNER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE8E8' } };

/** The saved nests as rows: one per cut plate on a lot, in lot order. */
function nestRows(model) {
  const rows = [];
  const lots = model.groups.flatMap((g) => g.nests).sort((a, b) => String(a.lotNo).localeCompare(String(b.lotNo), undefined, { numeric: true }));
  for (const n of lots) {
    const byCp = new Map();
    for (const p of n.pieces) {
      const hit = byCp.get(p.cutPlateId);
      if (hit) hit.qty += 1; else byCp.set(p.cutPlateId, { code: p.cutPlateCode, qty: 1 });
    }
    const verdict = n.origin === 'imported' ? (VERDICT_WORD[n.verdict] ?? '') : 'Fits';
    const notes = n.origin === 'imported'
      ? [...(n.reasons ?? []), n.forced ? 'Saved anyway.' : null].filter(Boolean).join(' ') || 'Imported.'
      : 'Automatic — laid out by our packer.';
    let first = true;
    for (const cp of byCp.values()) {
      rows.push({
        nest: n.lotNo, plate: n.plateCode ?? '', cutPlate: cp.code ?? '', qty: cp.qty, grade: n.grade ?? '',
        verdict: first ? verdict : '', notes: first ? notes : '',
      });
      first = false;
    }
  }
  return rows;
}

const INSTRUCTIONS = (model) => [
  ['How to bring nests in from another program'],
  [],
  [`Line ${model.line.lineNo} of order ${model.line.orderCode}`, model.saved ? 'The Nests tab holds the nests saved now.' : 'Nothing is nested on this line yet, so the Nests tab is empty — fill it in.'],
  [],
  ['SAVING REPLACES EVERY NEST ON THIS LINE.', 'Imported and automatic alike. Upload first shows a preview; nothing is written until you press Save.'],
  ['', 'Anything your sheet does not cover can be nested automatically afterwards with "Nest the rest".'],
  [],
  ['One row per cut plate on a nest', 'A nest is ONE standard plate and the cut plates cut from it, each with how many.'],
  ['Nest', 'Any label you like (the other program\'s nest number). Rows with the same label are one nest.'],
  ['', 'A blank Nest means "the same nest as the row above".'],
  ['Plate', 'The catalog plate code, or its size as thickness x length x width, e.g. 12 x 2500 x 1250.'],
  ['', 'Only needed on the nest\'s first row; the rows below it may leave it blank.'],
  ['Cut plate', 'Our cut plate code (see the Needed tab), or its size as thickness x length x width.'],
  ['Grade', 'Optional. Tells two cut plates of the same size but different steel apart.'],
  ['Qty', 'How many of that cut plate are on that nest. A whole number.'],
  ['Verdict / Notes', 'Written by us, never read back. Fits = our own layout fits it too. Tight = the area is enough'],
  ['', 'but our row-by-row layout could not do it (your program may have). Won\'t fit = it cannot work.'],
  ['', 'You may save a nest that is Tight or Won\'t fit ("Save anyway"); it is marked so.'],
  [],
  ['Sizes are read forgivingly', 'Spaces, x, X, × and * all work, a trailing mm is ignored, and 2,500 is two thousand five hundred.'],
  ['What blocks a save', 'A cell we cannot read: an unknown code, a size that matches nothing (or more than one thing),'],
  ['', 'a quantity that is not a whole number. Every such problem is listed at once.'],
  ['What needs "Save anyway"', 'A nest that is not Fits, or more pieces of a cut plate than the line needs (see Needed).'],
  ['', 'Fewer is fine — nest the rest automatically.'],
  ['Held back from automatic nesting', `A cut plate marked ${NEST_MANUAL_SPEC_CODE} is left out of automatic nesting, but may be on a nest here.`],
  [],
  ['Waste', 'Each saved nest\'s steel is split by cause: parts, kerf, sequence gaps, rim, offcuts (at least 300 x 300'],
  ['', 'and 100 mm across) and what is left, wastage.'],
];

/**
 * The line's nests as a workbook: Nests (filled with the saved nests), Needed
 * (every cut plate, needed / nested / left) and How to use this. A look is a
 * look: nothing is packed to fill it.
 *
 * Returns { filename, contentType, buffer, rows, lots, saved } — the route sends it.
 */
export async function exportSheet(db, companyId, orderLineId) {
  const model = await getNesting(db, companyId, orderLineId);
  const rows = nestRows(model);
  const stem = `NESTS_${model.line.orderCode}_L${model.line.lineNo}`.replace(/[^\w.-]+/g, '_');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  wb.created = new Date();

  const ws = wb.addWorksheet(NESTS_SHEET, { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = NEST_COLUMNS.map((c) => ({ width: c.width }));
  const banner = ws.addRow([BANNER]);
  ws.mergeCells(1, 1, 1, NEST_COLUMNS.length);
  banner.height = 32;
  banner.getCell(1).font = { bold: true, color: { argb: 'FFB00020' } };
  banner.getCell(1).fill = BANNER_FILL;
  banner.getCell(1).alignment = { vertical: 'middle', wrapText: true };
  const head = ws.addRow(NEST_COLUMNS.map((c) => (c.readOnly ? `${c.header}${RO}` : c.header)));
  head.font = { bold: true };
  NEST_COLUMNS.forEach((c, i) => { head.getCell(i + 1).fill = c.readOnly ? HEAD_RO : HEAD; });
  for (const r of rows) {
    const row = ws.addRow(NEST_COLUMNS.map((c) => r[c.key] ?? ''));
    NEST_COLUMNS.forEach((c, i) => { if (c.readOnly) row.getCell(i + 1).fill = GREY; });
  }

  const need = wb.addWorksheet(NEEDED_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  need.columns = NEEDED_COLUMNS.map((c) => ({ width: c.width }));
  const nh = need.addRow(NEEDED_COLUMNS.map((c) => c.header));
  nh.font = { bold: true };
  nh.eachCell((cell) => { cell.fill = HEAD_RO; });
  for (const c of model.coverage) {
    if (!c.needed && !c.nested) continue;
    need.addRow([c.cutPlateCode, c.thickness ?? '', c.length ?? '', c.width ?? '', c.grade ?? '', c.needed, c.nested, c.needed - c.nested]);
  }

  const notes = wb.addWorksheet(NOTES_SHEET);
  notes.columns = [{ width: 34 }, { width: 110 }];
  for (const l of INSTRUCTIONS(model)) notes.addRow(l);
  notes.getRow(1).font = { bold: true, size: 14 };
  notes.getRow(5).font = { bold: true, color: { argb: 'FFB00020' } };

  return {
    filename: `${stem}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    rows: rows.length,
    lots: new Set(rows.map((r) => r.nest)).size,
    saved: !!model.saved,
  };
}

/* ===========================================================================
 * Back in — reading the cells
 * ======================================================================== */

export const looksXlsx = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

async function readRows(buffer) {
  if (!looksXlsx(buffer)) throw invalid('BAD_FILE', 'That file is not an Excel workbook (.xlsx). Download the nesting sheet for this line and fill that in.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid('BAD_FILE', 'That file starts like a workbook but could not be opened as one.'); }
  const ws = wb.getWorksheet(NESTS_SHEET)
    ?? wb.worksheets.find((w) => ![NEEDED_SHEET, NOTES_SHEET].includes(w.name))
    ?? wb.worksheets[0];
  if (!ws) throw invalid('EMPTY_SHEET', 'That workbook has no sheets in it.');
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    const n = Math.max(row.cellCount, row.actualCellCount);
    for (let i = 1; i <= n; i++) cells.push(cellValue(row.getCell(i).value));
    out.push({ n: row.number, cells });
  });
  return { rows: out, sheetName: ws.name };
}

/** The header row and which column is which, or null. */
function findHeader(rows) {
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    const at = {};
    rows[i].cells.forEach((h, j) => {
      const key = HEADER_KEY.get(normaliseHeader(h));
      if (key && at[key] === undefined) at[key] = j;
    });
    if (at.nest !== undefined && at.cutPlate !== undefined && at.qty !== undefined) return { index: i, at };
  }
  return null;
}

/**
 * Cells -> nests, every problem collected. Plates and cut plates are matched
 * against the line (ctx) here; nothing about whether a nest WORKS is decided
 * here — that is checkNest's.
 */
function readNests(body, at, ctx, sheetName) {
  const problems = [];
  const where = (n, col) => `${sheetName} row ${n}${col ? `, ${col}` : ''}`;
  const cell = (r, key) => (at[key] === undefined ? null : r.cells[at[key]]);

  const plateByCode = new Map();
  for (const p of ctx.plates) { plateByCode.set(normCode(p.code), p); plateByCode.set(squash(p.code), p); }
  const cpByCode = new Map();
  for (const cp of ctx.cutPlates) if (cp.code) { cpByCode.set(normCode(cp.code), cp); cpByCode.set(squash(cp.code), cp); }
  const liveCutPlates = ctx.cutPlates;

  const nests = new Map();                          // UPPER label -> nest
  let current = null;
  for (const r of body) {
    const label = cell(r, 'nest');
    const plateRaw = cell(r, 'plate');
    const cpRaw = cell(r, 'cutPlate');
    const qtyRaw = cell(r, 'qty');
    const gradeRaw = cell(r, 'grade');
    if ([label, plateRaw, cpRaw, qtyRaw].every(blank)) continue;

    // ---- the nest --------------------------------------------------------
    if (!blank(label)) {
      const key = normCode(label);
      if (!nests.has(key)) nests.set(key, { nestNo: String(label).trim(), plateRaw: null, plateRow: null, rows: [], items: new Map(), sheetRows: [] });
      current = nests.get(key);
    } else if (!current) {
      problems.push(`${where(r.n, 'Nest')}: it has no Nest, and there is no nest above it to belong to.`);
      continue;
    }
    const nest = current;
    nest.sheetRows.push(r.n);

    if (!blank(plateRaw)) {
      if (nest.plateRaw != null && squash(nest.plateRaw) !== squash(plateRaw)) {
        problems.push(`${where(r.n, 'Plate')}: nest ${nest.nestNo} is given two plates (${nest.plateRaw} on row ${nest.plateRow}, ${plateRaw} here). A nest is ONE plate — put the other on a nest of its own.`);
      } else if (nest.plateRaw == null) {
        nest.plateRaw = String(plateRaw).trim();
        nest.plateRow = r.n;
      }
    }

    // ---- the cut plate ---------------------------------------------------
    if (blank(cpRaw) && blank(qtyRaw)) continue;     // a plate-only row
    if (blank(cpRaw)) { problems.push(`${where(r.n, 'Cut plate')}: it has a quantity but no cut plate.`); continue; }
    let cp = cpByCode.get(normCode(cpRaw)) ?? cpByCode.get(squash(cpRaw));
    if (!cp) {
      const size = parseSize(cpRaw);
      if (!size) {
        problems.push(`${where(r.n, 'Cut plate')}: "${cpRaw}" is not one of this line's cut plate codes, and it is not a size like 12 x 600 x 300 either. The Needed tab lists this line's cut plates.`);
        continue;
      }
      let hits = liveCutPlates.filter((c) => c.steel && sizeMatches(c.steel, size));
      const g = normGrade(gradeRaw);
      if (g) hits = hits.filter((c) => normGrade(c.steel.grade) === g);
      if (!hits.length) {
        problems.push(`${where(r.n, 'Cut plate')}: no cut plate of this line is ${size.join(' x ')}${g ? ` in ${gradeRaw}` : ''}. The Needed tab lists this line's cut plates and their sizes.`);
        continue;
      }
      if (hits.length > 1) {
        problems.push(`${where(r.n, 'Cut plate')}: ${size.join(' x ')} matches ${plural(hits.length, 'cut plate', 'cut plates')} (${hits.map((c) => `${c.code}${c.steel.grade ? ` ${c.steel.grade}` : ''}`).join(', ')})${g ? '' : ' — fill in the Grade column, or use the code'}.`);
        continue;
      }
      cp = hits[0];
    } else if (!blank(gradeRaw) && cp.steel?.grade && normGrade(gradeRaw) !== normGrade(cp.steel.grade)) {
      problems.push(`${where(r.n, 'Grade')}: ${cp.code} is ${cp.steel.grade}, not ${gradeRaw}.`);
      continue;
    }

    const qty = blank(qtyRaw) ? NaN : parseNumber(qtyRaw);
    if (blank(qtyRaw)) { problems.push(`${where(r.n, 'Qty')}: it has no quantity — how many of ${cp.code} are on nest ${nest.nestNo}?`); continue; }
    if (!Number.isFinite(qty)) { problems.push(`${where(r.n, 'Qty')}: "${qtyRaw}" is not a number.`); continue; }
    if (!Number.isInteger(qty) || qty <= 0) { problems.push(`${where(r.n, 'Qty')}: ${qty} — a quantity is a whole number more than zero.`); continue; }
    const had = nest.items.get(cp.id);
    nest.items.set(cp.id, { cutPlate: cp, qty: (had?.qty ?? 0) + qty });
  }

  // ---- each nest's plate, matched once its cut plates are known ------------
  const out = [];
  for (const nest of nests.values()) {
    const first = nest.sheetRows[0];
    if (!nest.items.size) { problems.push(`${where(first)}: nest ${nest.nestNo} has no cut plates on it.`); continue; }
    if (nest.plateRaw == null) { problems.push(`${where(first, 'Plate')}: nest ${nest.nestNo} does not say which plate it is.`); continue; }
    const items = [...nest.items.values()];
    const steel = items[0].cutPlate.steel ?? {};
    let plate = plateByCode.get(normCode(nest.plateRaw)) ?? plateByCode.get(squash(nest.plateRaw));
    if (!plate) {
      const size = parseSize(nest.plateRaw);
      if (!size) {
        problems.push(`${where(nest.plateRow, 'Plate')}: "${nest.plateRaw}" is not a catalog plate code, and not a size like 12 x 2500 x 1250 either.`);
        continue;
      }
      let hits = ctx.plates.filter((p) => p.steel?.length > 0 && sizeMatches(p.steel, size));
      if (hits.length > 1) {
        // The nest's own steel decides: an exact grade and material first,
        // then a plate that states none (a catalog gap, not a contradiction).
        const exact = hits.filter((p) => normGrade(p.steel.grade) === normGrade(steel.grade) && normGrade(p.steel.material) === normGrade(steel.material));
        const loose = hits.filter((p) => (p.steel.grade == null || normGrade(p.steel.grade) === normGrade(steel.grade))
          && (p.steel.material == null || normGrade(p.steel.material) === normGrade(steel.material)));
        hits = exact.length ? exact : loose.length ? loose : hits;
      }
      if (!hits.length) {
        problems.push(`${where(nest.plateRow, 'Plate')}: no catalog plate is ${size.join(' x ')}. Add it to the catalog, or use the code of the plate you mean.`);
        continue;
      }
      if (hits.length > 1) {
        problems.push(`${where(nest.plateRow, 'Plate')}: ${size.join(' x ')} matches ${plural(hits.length, 'catalog plate', 'catalog plates')} (${hits.map((p) => p.code).join(', ')}) — use the code of the one you mean.`);
        continue;
      }
      plate = hits[0];
    }
    out.push({ nestNo: nest.nestNo, plate, items, sheetRows: [first, nest.sheetRows[nest.sheetRows.length - 1]] });
  }
  return { nests: out, problems, anyRows: nests.size > 0 };
}

/* ===========================================================================
 * Back in — the preview, and the save
 * ======================================================================== */

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * Reads an uploaded nesting sheet onto an order line.
 *
 *   input.file (or fileBase64)  the workbook, base64 (a Buffer is taken too)
 *   input.filename              only for messages
 *   input.dryRun                true: the preview, nothing written
 *   input.force                 save although a nest is not `fits`, or a
 *                               cut plate is over-covered ("Save anyway")
 *
 * Returns the contract's preview:
 *   { applied, canSave, needsForce, problems, nests, coverage }
 * plus line, dryRun, message and, when applied, what was written (saved).
 * Cell problems block a save; they never throw, so the preview can show them.
 */
export async function importSheet(db, c, orderLineId, input = {}) {
  const dryRun = truthy(input.dryRun);
  const force = truthy(input.force);

  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to read — send the file as `file` (base64).');
  let buffer;
  try { buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64'); } catch { throw invalid('BAD_FILE', 'That file could not be read — send it as base64.'); }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');

  const { rows, sheetName } = await readRows(buffer);
  const header = findHeader(rows);
  if (!header) {
    throw invalid('WRONG_SHEET', 'That workbook has no Nest, Cut plate and Qty columns, so it is not a nesting sheet. Download the sheet for this line and fill that in.');
  }
  const body = rows.slice(header.index + 1);
  if (body.length > MAX_ROWS) throw invalid('TOO_BIG', `A sheet of more than ${MAX_ROWS} rows is more than this takes in one go.`);

  const ctx = await importContext(db, c.companyId, orderLineId, { pack: input.pack });
  const read = readNests(body, header.at, ctx, sheetName);
  const problems = [...read.problems];
  if (!read.anyRows) problems.push(`The ${sheetName} tab has no nests on it. Fill in one row per cut plate on each nest.`);
  const blocker = importBlocker(ctx.line);
  if (blocker) problems.push(blocker.message);

  // Every nest whose cells all read is checked, even when another row has a
  // problem: seeing the verdicts and the problems together is the point.
  const { nests: checked, coverage } = await checkImportedNests(ctx, read.nests);

  const notFits = checked.filter((n) => n.verdict !== 'fits').length;
  const over = coverage.filter((x) => x.diff > 0);
  const short = coverage.filter((x) => x.diff < 0);
  const canSave = problems.length === 0 && checked.length > 0;
  const needsForce = notFits > 0 || over.length > 0;

  const say = [];
  if (problems.length) say.push(`${plural(problems.length, 'cell needs', 'cells need')} fixing before this can be saved`);
  say.push(`${plural(checked.length, 'nest', 'nests')} read`);
  if (notFits) say.push(`${notFits} not fitting our rules`);
  if (over.length) say.push(`${plural(over.length, 'cut plate is', 'cut plates are')} over what the line needs`);
  if (short.length) say.push(`${plural(short.length, 'cut plate is', 'cut plates are')} short — nest the rest afterwards`);

  const out = {
    line: ctx.lineHead,
    dryRun,
    applied: false,
    canSave,
    needsForce,
    problems,
    nests: checked.map(({ _save, ...n }) => n),
    coverage,
    replaces: 'Saving replaces every nest on this line — imported and automatic alike.',
    message: `${say.join(', ')}.`,
  };
  if (dryRun || !canSave) return out;
  if (needsForce && !force) {
    return { ...out, message: `${out.message} Not saved: ${notFits ? 'a nest does not fit our rules' : 'a cut plate is over-covered'} — save anyway to keep it.` };
  }

  const saved = await saveImportedNests(db, c, orderLineId, ctx, checked);
  return { ...out, applied: true, forced: needsForce, saved, message: `Saved ${plural(saved.lots, 'nest', 'nests')} (${plural(saved.pieces, 'piece', 'pieces')}, ${plural(saved.offcuts, 'offcut', 'offcuts')}); every earlier nest on the line was replaced.` };
}
