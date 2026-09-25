/**
 * nestingSheetService.js — a line's nesting layout as a spreadsheet, out and
 * back in again.
 *
 * WHY THIS EXISTS
 * The screen draws the plates and a person can drag a rectangle on it, but the
 * shop does not lay steel out on a screen. It lays it out on paper, in Excel,
 * with the cutting supervisor reading over a shoulder. bomSheetService made the
 * same argument for the BOM and it is the reason cf_erp is used at all; this is
 * the same idea for the nesting plan, and it is the ONLY way a layout can be
 * written entirely BY HAND — typed lot, sequence, row and corner, with no
 * packer involved at any point.
 *
 * UPLOADING THE SHEET IS ACCEPTING IT.
 * There is no separate confirm. The file goes straight to nestingService's
 * acceptNesting, which verifies it against the database and writes the lots,
 * the placements and the plate quantity on every cut plate's BOM line. fab
 * shipped this behaviour without saying so and it surprised people, so it is
 * said THREE times: in a banner across the top of the data sheet itself, on
 * the "How to use this" tab, and in the sentence this service returns. The
 * banner is on the grid rather than only on the notes tab because a CSV has no
 * second tab and shading does not survive one either.
 *
 * WHAT IDENTIFIES A ROW
 * Not its position. A person sorts by plate, filters to one sequence, inserts
 * and deletes. Every row carries
 *   Row ID   the cf_nest_placements id it was exported from, blank for a row
 *            somebody added
 * and the import matches on it. Sorting the sheet upside down changes nothing;
 * duplicating a Row ID is refused, because a copy-pasted row would otherwise
 * quietly cut the same blank twice; a Row ID belonging to another line is
 * refused, because that is a sheet pasted in from somewhere else.
 *
 * THE SHEET IS THE WHOLE PLAN, WHICH IS THE OPPOSITE OF THE BOM SHEET.
 * In the BOM sheet a row left out is "not mentioned" and nothing happens to it.
 * Here a row left out is a piece that is NOT PLACED, and a layout that does not
 * place everything the line needs has no honest plate count, so it is refused
 * and says which rectangles are short. That asymmetry is deliberate and is the
 * loudest line on the notes tab: there is no way to write "put this one
 * somewhere sensible", and a filtered sheet is not a safe thing to upload.
 *
 * ONE ROW IS ONE PIECE. Never a row with a quantity. A cut plate the line needs
 * six times is six rows with six corners, because each piece is cut somewhere
 * and the floor is given the sheet.
 *
 * THE VERIFIER IS NOT WRITTEN TWICE. Everything about whether a layout is
 * POSSIBLE — pieces that overlap, a piece hanging off the plate, a piece inside
 * the rim kerf, a sequence holding more rows than its part size allows,
 * sequences closer than the sequence gap, a rectangle drawn at a size it is
 * not, steel that does not match the plate, a piece count that does not add up
 * — is nestingService's, reached through acceptNesting. This file only turns
 * cells into the shape acceptNesting already takes, and turns its refusals back
 * into sentences that name a spreadsheet row.
 *
 * A DRY RUN IS THE REAL ACCEPT, ROLLED BACK TO A SAVEPOINT.
 * The only honest answer to "what would this do" is what it does, so a dry run
 * runs acceptNesting for real inside a SAVEPOINT and rolls back to it. Nothing
 * survives, and the report includes the things only the write path knows — the
 * plate quantity each cut plate's BOM line would end up with, and every
 * geometric refusal, collected. The alternative was a second, half-copy of the
 * verification that would drift from the real one the first week; fab had two
 * kerf constants in two files and made every offcut 2 mm small.
 * Because of that, this service REQUIRES a transaction: it is handed the
 * caller's connection, never the pool, and it says so rather than issuing a
 * SAVEPOINT against a connection that is not in a transaction.
 *
 * EVERY PROBLEM AT ONCE. Reading the cells collects every problem it can find
 * and throws them together (assertNoProblems, the house pattern); if the cells
 * all read, the geometry is checked and ITS problems come back together too.
 * The two are separate passes for one reason: a row whose cut plate code does
 * not resolve has no rectangle, and there is nothing to say about where a
 * rectangle nobody can identify is sitting.
 */
import ExcelJS from 'exceljs';
import { invalid, assertNoProblems, CfError } from '../lib/errors.js';
import {
  getNesting, planNesting, acceptNesting, resolveCutSettings, orderedSize,
  NEST_MANUAL_SPEC_CODE, SMALL_PART_MM,
} from './nestingService.js';

export const SHEET_NAME = 'NESTING';
export const NOTES_SHEET = 'How to use this';

/** A layout of more rows than this is not something one upload should take. */
const MAX_ROWS = 20000;

/** How far down a file the header row may hide before we give up looking. */
const HEADER_SEARCH_ROWS = 12;

/** mm are stored to three decimals, so anything under a micron is the same number. */
const EPS = 0.0005;

/**
 * THE BANNER. Row 1 of the data sheet, in words, because this is the one thing
 * about this feature that catches people out and neither cell shading nor a
 * second tab survives a CSV.
 */
export const BANNER = 'UPLOADING THIS SHEET IS ACCEPTING IT — there is no separate confirm step. '
  + 'The moment this file is read back, these plates and these positions replace whatever was saved, '
  + 'and the plate quantity on every cut plate is rewritten from them. '
  + 'Ask for a dry run first if you want to see what it would do.';

/* ---------------------------------------------------------------------------
 * Columns.
 *
 * `locked` columns are written by the export for context and IGNORED on the way
 * back in. They are shaded in the workbook and their header says so in words,
 * because a CSV carries no shading and the header is then the only warning that
 * survives the round trip — bomSheetService's rule, for bomSheetService's
 * reason.
 *
 * Everything the layout actually IS comes from the unlocked columns: which
 * plate a lot is, and for each piece its sequence, its row, its corner and its
 * footprint. Those, and nothing else, are what a person types when they lay a
 * plate out by hand.
 * ------------------------------------------------------------------------ */
const LOCK = ' [do not edit]';
export const COLUMNS = [
  { key: 'rowId', header: 'Row ID', width: 10, locked: true },

  // --- the lot: one physical plate ---------------------------------------
  { key: 'lot', header: 'Lot', width: 9 },
  { key: 'plateCode', header: 'Plate Code', width: 24 },
  { key: 'plateName', header: 'Plate', width: 26, locked: true },
  { key: 'plateSize', header: 'Plate Size (mm)', width: 17, locked: true },
  { key: 'thickness', header: 'Thickness (mm)', width: 13, locked: true },
  { key: 'grade', header: 'Grade', width: 10, locked: true },
  { key: 'material', header: 'Material', width: 10, locked: true },
  // The two numbers the shop keeps apart on purpose: what the layout needs,
  // and what procurement actually buys (+100 length / +50 width, rounded up).
  { key: 'needs', header: 'Layout Needs (mm)', width: 18, locked: true },
  { key: 'order', header: 'Order Plate (mm)', width: 18, locked: true },
  { key: 'source', header: 'Source', width: 9 },
  { key: 'byHand', header: 'By Hand?', width: 9 },

  // --- the piece ----------------------------------------------------------
  { key: 'cutPlateCode', header: 'Cut Plate Code', width: 24 },
  { key: 'cutPlateName', header: 'Cut Plate', width: 26, locked: true },
  { key: 'pieceSize', header: 'Piece Size (mm)', width: 16, locked: true },
  { key: 'seqNo', header: 'Seq', width: 6 },
  { key: 'rowNo', header: 'Row', width: 6 },
  // Worked out, not typed: position along a row is re-derived from X so that it
  // is dense and 1-based whatever a person's spreadsheet ends up containing.
  { key: 'posNo', header: 'Pos', width: 6, locked: true },
  { key: 'x', header: 'X (mm)', width: 11 },
  { key: 'y', header: 'Y (mm)', width: 11 },
  { key: 'length', header: 'Length (mm)', width: 12 },
  { key: 'width', header: 'Width (mm)', width: 12 },
  { key: 'rotated', header: 'Rotated?', width: 10 },
];

/**
 * A header down to the name it is matched by: everything before the first
 * bracket or parenthesis, upper-cased. `X (mm)` -> X, `Row ID [do not edit]` ->
 * ROW ID. One rule, so a header can carry its unit and its warning without the
 * import losing track of it. Same function as bomSheetService, on purpose.
 */
export const normaliseHeader = (h) => String(h ?? '').split(/[([]/)[0].trim().toUpperCase();
const BY_HEADER = new Map(COLUMNS.map((c) => [normaliseHeader(c.header), c]));

/** The columns without which a file is not a nesting sheet at all. */
const REQUIRED_COLUMNS = ['rowId', 'lot', 'plateCode', 'cutPlateCode', 'seqNo', 'rowNo', 'x', 'y'];

/** Whichever of these comes to hand. Anything else is refused, never read as a no. */
const YES = new Set(['yes', 'y', 'true', '1', 'x']);
const NO = new Set(['no', 'n', 'false', '0', '-', '']);

/* --- small helpers -------------------------------------------------------- */
const blank = (v) => v == null || String(v).trim() === '';
const text = (v) => (blank(v) ? null : String(v).trim());
const round3 = (n) => Number(Number(n).toFixed(3));
const same = (a, b) => Math.abs(Number(a) - Number(b)) <= EPS;
const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : String(round3(n)));
const pair = (a, b) => (a == null || b == null ? '' : `${fmt(a)} × ${fmt(b)}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One ExcelJS cell as plain text: formulas, rich text and dates all flattened. */
function cellText(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim() || null;
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return cellText(v.text ?? v.hyperlink);
    if ('error' in v) return null;
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* --- CSV, by hand --------------------------------------------------------- */
// exceljs reads and writes CSV through a date-guessing stream with its own
// options; this file needs neither, and thirty lines of RFC 4180 are easier to
// be sure about than the options that would otherwise have to be right. Lifted
// deliberately from bomSheetService so both sheets behave the same way.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

function parseCsv(str) {
  const s = str.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ===========================================================================
 * The model behind the sheet
 * ======================================================================== */

/**
 * The saved plan, or a fresh proposal when nothing has been accepted yet —
 * because somebody opening the sheet on a line that has never been nested wants
 * something to edit, not an empty file. A LOOK IS STILL A LOOK: proposing
 * writes nothing either.
 */
async function modelFor(db, companyId, orderLineId, { plan, pack }) {
  if (plan) return plan;
  const saved = await getNesting(db, companyId, orderLineId);
  if (saved.saved) return saved;
  return planNesting(db, companyId, orderLineId, { pack });
}

/**
 * What the layout on one lot NEEDS, as opposed to what is bought: the pieces'
 * bounding box plus one kerf at each rim, because the raw plate's own edge is
 * cut too. This mirrors nestingService.requiredSize, which is not exported; it
 * is computed here rather than read off the lot row so that the number is right
 * for a PROPOSED plate and for a plate somebody is in the middle of editing,
 * not only for one already saved.
 */
function needsOf(pieces, kerfMm) {
  const k = Number(kerfMm) || 0;
  if (!pieces.length) return { length: round3(2 * k), width: round3(2 * k) };
  return {
    length: round3(Math.max(...pieces.map((p) => Number(p.x) + Number(p.length))) + k),
    width: round3(Math.max(...pieces.map((p) => Number(p.y) + Number(p.width))) + k),
  };
}

/**
 * The ordering margins for a group. A PROPOSED group carries them; a SAVED one
 * does not, because the lot row records the kerf and the gaps it was accepted
 * with but not the margins — so they are resolved from cf_cut_settings, through
 * the one resolver, for the group's own thickness.
 */
async function marginsFor(db, companyId, group, cache) {
  if (group.orderMarginLengthMm != null && group.orderMarginWidthMm != null) {
    return {
      length: Number(group.orderMarginLengthMm),
      width: Number(group.orderMarginWidthMm),
      step: Number(group.orderStepMm ?? 50),
    };
  }
  const key = String(group.thickness);
  if (!cache.has(key)) {
    const s = await resolveCutSettings(db, companyId, group.thickness);
    cache.set(key, { length: s.orderMarginLengthMm, width: s.orderMarginWidthMm, step: s.orderStepMm });
  }
  return cache.get(key);
}

/** The rows of the sheet, in cut order: group, then lot, then sequence/row/position. */
async function sheetRows(db, companyId, model) {
  const cache = new Map();
  const out = [];
  for (const g of model.groups) {
    const margins = await marginsFor(db, companyId, g, cache);
    const cpById = new Map((g.cutPlates ?? []).map((cp) => [cp.id, cp]));
    for (const n of g.nests) {
      const needs = needsOf(n.pieces, g.kerfMm);
      const order = {
        length: orderedSize(needs.length, margins.length, margins.step),
        width: orderedSize(needs.width, margins.width, margins.step),
      };
      const pieces = n.pieces.slice().sort((a, b) =>
        a.seqNo - b.seqNo || a.rowNo - b.rowNo || (a.posNo ?? 0) - (b.posNo ?? 0) || a.x - b.x || a.y - b.y);
      for (const p of pieces) {
        const cp = cpById.get(p.cutPlateId);
        out.push({
          rowId: p.id ?? '',
          lot: n.lotNo ?? '',
          plateCode: n.plateCode ?? '',
          plateName: n.plateName ?? '',
          plateSize: pair(n.length, n.width),
          thickness: n.thickness ?? g.thickness ?? '',
          grade: n.grade ?? g.grade ?? '',
          material: n.material ?? g.material ?? '',
          needs: pair(needs.length, needs.width),
          order: pair(order.length, order.width),
          source: n.source ?? 'catalog',
          byHand: n.isManual ? 'yes' : 'no',
          cutPlateCode: p.cutPlateCode ?? cp?.code ?? '',
          cutPlateName: cp?.name ?? '',
          pieceSize: cp ? pair(cp.length, cp.width) : pair(p.length, p.width),
          seqNo: p.seqNo,
          rowNo: p.rowNo,
          posNo: p.posNo ?? '',
          x: round3(p.x),
          y: round3(p.y),
          length: round3(p.length),
          width: round3(p.width),
          rotated: p.rotated ? 'yes' : 'no',
        });
      }
    }
  }
  return out;
}

const INSTRUCTIONS = (model) => [
  ['How to lay a plate out in this sheet'],
  [],
  [`Line ${model.line.lineNo} of order ${model.line.orderCode}`, model.saved ? 'This is the saved plan.' : 'Nothing has been accepted on this line yet, so this is a PROPOSAL. It is not saved until you upload it back.'],
  [],
  ['UPLOADING THIS SHEET IS ACCEPTING IT.', 'There is no separate confirm step. The moment this file is read back, these plates and these'],
  ['', 'positions replace whatever was saved, and the plate quantity on every cut plate is rewritten'],
  ['', 'from them. This surprised people in the other system, so it is said here, on the sheet itself,'],
  ['', 'and in the message you get back. Ask for a dry run to see what it would do before it does it.'],
  [],
  ['THE SHEET IS THE WHOLE PLAN.', 'This is the opposite of the BOM sheet. A row that is not here is NOT "left alone" — it is a'],
  ['', 'piece that is not placed, and a layout that does not place everything the line needs is refused'],
  ['', 'and tells you which rectangles are short. So do not filter this sheet down and upload the part'],
  ['', 'you were looking at. Upload the whole thing.'],
  [],
  ['One row is one piece.', 'A rectangle the line needs six times is six rows, each with its own corner. There is no'],
  ['', 'quantity column and there is not going to be one.'],
  [],
  ['The columns that matter'],
  ['Row ID', 'How the system finds a row again after you have sorted, filtered and inserted. Never type in'],
  ['', 'it. A row you ADD just has an empty Row ID. The same Row ID twice is refused, because a'],
  ['', 'copy-pasted row would otherwise quietly cut the same blank twice.'],
  ['Lot', 'ONE PHYSICAL PLATE. Every row sharing a Lot is cut from the same piece of steel, and that is'],
  ['', 'what a nest is. Type a new Lot label to open a new plate; the labels are renumbered N-001,'],
  ['', 'N-002 … in the order they first appear, so the label is a grouping key, not a name.'],
  ['Plate Code', 'The catalog plate the lot IS. Every row of a lot must name the same one. It has to be the'],
  ['', 'same thickness as the pieces on it and its grade and material must not contradict theirs.'],
  ['Source / By Hand?', 'catalog or offcut, and whether you laid this plate out yourself. Blank By Hand? means yes for'],
  ['', 'a lot with no Row IDs on it at all — a plate that has no history is one somebody typed.'],
  ['Seq / Row', 'THE CUT ORDER, AND THE POINT OF THE WHOLE THING. The plate is cut sequence by sequence, each'],
  ['', 'one in full before the next starts, so the cutting head cannot pierce anywhere it likes and'],
  ['', `shift a part mid-cut. A sequence whose parts are all under ${SMALL_PART_MM} mm on BOTH dimensions is Small`],
  ['', 'and holds 2 rows; anything bigger is Big and holds 3. Consecutive sequences must stand apart'],
  ['', 'by the sequence gap shown below. A sheet that breaks either rule is refused, not rounded.'],
  ['X / Y', 'The piece\'s own corner, from the plate\'s corner, in millimetres. KERF IS CUT AT THE PLATE RIM'],
  ['', 'TOO, so nothing may sit closer to an edge than one kerf. Two pieces may SHARE a boundary — one'],
  ['', 'kerf, cut once — but never be closer than that, and never overlap.'],
  ['Length / Width', 'The footprint AS PLACED. Leave them blank to mean the rectangle\'s own size. They are not a'],
  ['', 'resize: a placement is the rectangle itself, and a different size is refused.'],
  ['Rotated?', 'yes swaps the rectangle\'s length and width. Length and Width are then the swapped ones.'],
  [],
  ['Grey columns', 'Written for context and ignored when this comes back. Pos in particular is worked out from X'],
  ['', 'along the row, so renumbering it by hand does nothing.'],
  [],
  ['Layout Needs vs Order Plate', 'TWO DIFFERENT NUMBERS, BOTH REAL. Layout Needs is what this layout takes, kerf and rim'],
  ['', 'included. Order Plate is what procurement buys: +100 mm on length and +50 mm on width, rounded'],
  ['', 'up, because mill edges are not straight and a standard size procures faster. The difference is'],
  ['', 'deliberate and it is not waste.'],
  [],
  ['Holding a rectangle back', `Set ${NEST_MANUAL_SPEC_CODE} on the cut plate itself. A rectangle marked that way is not expected in this`],
  ['', 'sheet at all, and one that IS marked cannot also appear on a packed plate.'],
  [],
  ['Nothing is applied unless it all works', 'Every problem is reported at once and none of them is applied. A sheet with two mistakes tells'],
  ['', 'you about both.'],
  [],
  ['This plan\'s cutting numbers'],
  ...model.groups.map((g) => [
    `${fmt(g.thickness)} mm ${[g.material, g.grade].filter(Boolean).join(' ')}`.trim(),
    `kerf ${fmt(g.kerfMm)} mm, sequences ${fmt(g.seqGapMinMm)}–${fmt(g.seqGapMaxMm)} mm apart (${g.settingsBasis})`,
  ]),
  ...(model.groups.length ? [] : [['', 'There is nothing to nest on this line yet.']]),
  ...(model.manual?.length
    ? [[], ['Laid out by hand, not in this sheet', model.manual.map((m) => m.code).join(', ')]]
    : []),
];

const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
const HEAD_LOCKED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDDDDD' } };
const BANNER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE8E8' } };

/* ===========================================================================
 * Out
 * ======================================================================== */

/**
 * The layout for one order line as a workbook (or a CSV).
 *
 *   plan  a proposal the caller is already showing, so the file matches the
 *         screen exactly instead of being re-derived behind it
 *   pack  the packer, injected — only reached when nothing is saved yet
 *
 * Returns { filename, contentType, buffer, rows, saved } — the route sends it.
 */
export async function exportSheet(db, companyId, orderLineId, { format = 'xlsx', plan = null, pack } = {}) {
  const kind = String(format ?? '').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const model = await modelFor(db, companyId, orderLineId, { plan, pack });
  const rows = await sheetRows(db, companyId, model);
  const headers = COLUMNS.map((c) => (c.locked ? `${c.header}${LOCK}` : c.header));
  const body = rows.map((r) => COLUMNS.map((c) => r[c.key] ?? ''));
  const stem = `NESTING_${model.line.orderCode}_L${model.line.lineNo}`.replace(/[^\w.-]+/g, '_');
  const head = {
    rows: rows.length,
    lots: new Set(rows.map((r) => r.lot)).size,
    saved: !!model.saved,
    format: kind,
  };

  if (kind === 'csv') {
    // The banner is its own first line, ahead of the header row, so the warning
    // survives a format that carries no colour and has no second tab. The
    // importer looks for the header row rather than assuming row 1, for exactly
    // this reason.
    const csv = toCsv([[BANNER], headers, ...body]);
    return { ...head, filename: `${stem}.csv`, contentType: 'text/csv; charset=utf-8', buffer: Buffer.from(csv, 'utf8') };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }] });
  ws.columns = COLUMNS.map((c) => ({ width: c.width }));

  const banner = ws.addRow([BANNER]);
  ws.mergeCells(1, 1, 1, COLUMNS.length);
  banner.height = 30;
  banner.getCell(1).font = { bold: true, color: { argb: 'FFB00020' }, size: 11 };
  banner.getCell(1).fill = BANNER_FILL;
  banner.getCell(1).alignment = { vertical: 'middle', wrapText: true };

  const headRow = ws.addRow(headers);
  headRow.font = { bold: true };
  headRow.alignment = { vertical: 'middle', wrapText: true };
  headRow.height = 30;
  COLUMNS.forEach((c, i) => { headRow.getCell(i + 1).fill = c.locked ? HEAD_LOCKED : HEAD; });

  for (const line of body) {
    const r = ws.addRow(line);
    COLUMNS.forEach((c, i) => { if (c.locked) r.getCell(i + 1).fill = GREY; });
  }
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLUMNS.length } };

  const notes = wb.addWorksheet(NOTES_SHEET);
  notes.columns = [{ width: 30 }, { width: 108 }];
  for (const l of INSTRUCTIONS(model)) notes.addRow(l);
  notes.getRow(1).font = { bold: true, size: 14 };
  notes.getRow(5).font = { bold: true, color: { argb: 'FFB00020' } };

  return {
    ...head,
    filename: `${stem}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  };
}

/* ===========================================================================
 * Back in — reading the cells
 * ======================================================================== */

/** xlsx is a zip; a CSV is not. Sniffing beats trusting a file name. */
export const looksXlsx = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

/** Every row of the file as { n, cells }, keeping the spreadsheet's own row numbers. */
async function readRows(buffer) {
  if (looksXlsx(buffer)) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); }
    catch { throw invalid('BAD_FILE', 'That file starts like a workbook but could not be opened as one.'); }
    const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets.find((w) => w.name !== NOTES_SHEET) ?? wb.worksheets[0];
    if (!ws) throw invalid('EMPTY_SHEET', 'That workbook has no sheets in it.');
    const out = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      const n = Math.max(row.cellCount, row.actualCellCount);
      for (let i = 1; i <= n; i++) cells.push(cellText(row.getCell(i).value));
      out.push({ n: row.number, cells });
    });
    return out;
  }
  return parseCsv(buffer.toString('utf8'))
    .map((cells, i) => ({ n: i + 1, cells: cells.map((v) => (String(v).trim() === '' ? null : String(v).trim())) }));
}

/**
 * Finds the header row rather than assuming row 1, because the sheet's own
 * first row is the banner and a person may well have typed a title above it.
 * A row counts as the header when it names the columns without which this is
 * not a nesting sheet.
 */
function findHeader(rows) {
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    const names = new Set(rows[i].cells.map(normaliseHeader).filter(Boolean));
    if (names.has('LOT') && names.has('CUT PLATE CODE') && names.has('X')) return i;
  }
  return -1;
}

/** Header cells -> { key -> column index }, every duplicate and omission reported. */
function mapHeaders(cells, problems) {
  const at = {};
  const seen = new Set();
  cells.forEach((h, i) => {
    const name = normaliseHeader(h);
    if (!name) return;
    if (seen.has(name)) { problems.push(`The column "${String(h).trim()}" appears twice — there can only be one of each.`); return; }
    seen.add(name);
    const col = BY_HEADER.get(name);
    if (col) at[col.key] = i;
  });
  for (const key of REQUIRED_COLUMNS) {
    if (at[key] === undefined) {
      const c = COLUMNS.find((x) => x.key === key);
      problems.push(`The sheet has no "${c.header}" column, so it is not a nesting layout. Download the sheet for this line and edit that copy.`);
    }
  }
  return at;
}

/** A number, or NaN with a problem recorded. Blank comes back as null. */
function number(raw, at, what, problems, { integer = false, positive = false } = {}) {
  if (blank(raw)) return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) { problems.push(`Row ${at}: ${what} is "${String(raw).trim()}", which is not a number.`); return NaN; }
  if (integer && !Number.isInteger(n)) { problems.push(`Row ${at}: ${what} is ${n} and it has to be a whole number.`); return NaN; }
  if (positive && n <= 0) { problems.push(`Row ${at}: ${what} is ${n} and it has to be more than zero.`); return NaN; }
  return n;
}

/** yes / no, and nothing else — guessing at a boolean is how work gets destroyed. */
function boolean(raw, at, what, problems, fallback = null) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return fallback;
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  problems.push(`Row ${at}: ${what} is "${String(raw).trim()}" — write yes or no.`);
  return fallback;
}

/* ===========================================================================
 * Back in — turning the cells into a plan
 * ======================================================================== */

/**
 * The lots the sheet describes, in the order their labels first appear, ready
 * for acceptNesting. Nothing here decides whether the layout is POSSIBLE; that
 * is nestingService's job and it is asked next.
 */
function buildLots(rows, at, { idByCode, savedById, knownIds, problems }) {
  const lots = new Map();
  const seenRowIds = new Map();
  let stale = 0;
  const cell = (r, key) => (at[key] === undefined ? null : r.cells[at[key]]);

  for (const r of rows) {
    const n = r.n;
    const lotLabel = text(cell(r, 'lot'));
    const cutCode = text(cell(r, 'cutPlateCode'));
    // A row with neither a lot nor a rectangle is an empty line somebody left
    // behind, not a piece. Anything with one of the two is meant.
    if (lotLabel == null && cutCode == null) continue;

    if (lotLabel == null) {
      problems.push(`Row ${n}: it has no Lot. Every piece is cut from a plate, and the Lot is which plate.`);
      continue;
    }

    // ---- identity -------------------------------------------------------
    const rawId = text(cell(r, 'rowId'));
    let rowId = null;
    let hadId = false;
    if (rawId != null) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        problems.push(`Row ${n}: Row ID "${rawId}" is not one this sheet wrote. Leave Row ID alone, or clear it to add a new piece.`);
      } else if (seenRowIds.has(id)) {
        problems.push(`Row ${n}: Row ID ${id} is already on row ${seenRowIds.get(id)}. A copied row keeps the Row ID of the one it came from, and two rows cannot be the same piece — clear the Row ID on the copy.`);
      } else if (savedById.has(id)) {
        seenRowIds.set(id, n);
        rowId = id;
        hadId = true;
      } else if (knownIds.has(id)) {
        // AN OUT-OF-DATE COPY OF THE SHEET, WHICH IS NOT AN ERROR. Accepting a
        // sheet replaces every placement, so the file somebody just uploaded
        // already names ids that no longer exist — and re-uploading the same
        // file, to be sure it took, is the commonest thing anyone does. These
        // rows are taken at face value; the diff below matches them by where
        // they sit instead, so an unchanged re-upload still reads as "nothing
        // to change" rather than as the whole plate being torn up and relaid.
        seenRowIds.set(id, n);
        stale += 1;
        hadId = true;
      } else {
        problems.push(`Row ${n}: Row ID ${id} has never been a piece of this line's layout. That row has been pasted in from another sheet — clear its Row ID if you meant to add a new piece.`);
      }
    }

    // ---- the lot --------------------------------------------------------
    if (!lots.has(lotLabel)) {
      lots.set(lotLabel, {
        lotNo: lotLabel, plateItemId: null, plateCode: null,
        source: null, isManual: null, pieces: [], sheetRows: [], anyRowId: false,
      });
    }
    const lot = lots.get(lotLabel);
    lot.sheetRows.push(n);
    // An out-of-date Row ID is still a history: the plate came out of an
    // export, so it is not one somebody typed from nothing.
    if (hadId) lot.anyRowId = true;

    const plateCode = text(cell(r, 'plateCode'));
    if (plateCode == null) {
      problems.push(`Row ${n}: lot ${lotLabel} does not say which catalog plate it is.`);
    } else {
      const plateId = idByCode.get(plateCode.toUpperCase());
      if (plateId == null) {
        problems.push(`Row ${n}: there is no item with the code ${plateCode} in this company, so lot ${lotLabel} names a plate that does not exist.`);
      } else if (lot.plateItemId != null && lot.plateItemId !== plateId) {
        problems.push(`Row ${n}: lot ${lotLabel} is given two different plates (${lot.plateCode} and ${plateCode}). A lot is ONE physical plate — put the second one on a lot of its own.`);
      } else {
        lot.plateItemId = plateId;
        lot.plateCode = plateCode;
      }
    }

    const src = text(cell(r, 'source'));
    if (src != null && lot.source == null) {
      const s = src.toLowerCase();
      if (s !== 'catalog' && s !== 'offcut') problems.push(`Row ${n}: Source is "${src}" — a lot is either catalog or offcut.`);
      else lot.source = s;
    }
    const byHand = boolean(cell(r, 'byHand'), n, 'By Hand?', problems);
    if (byHand != null && lot.isManual == null) lot.isManual = byHand;

    // ---- the piece ------------------------------------------------------
    if (cutCode == null) {
      problems.push(`Row ${n}: it has no Cut Plate Code, so there is no rectangle to place.`);
      continue;
    }
    const cutPlateId = idByCode.get(cutCode.toUpperCase());
    if (cutPlateId == null) {
      problems.push(`Row ${n}: there is no item with the code ${cutCode} in this company.`);
      continue;
    }

    const seqNo = number(cell(r, 'seqNo'), n, 'Seq', problems, { integer: true, positive: true });
    const rowNo = number(cell(r, 'rowNo'), n, 'Row', problems, { integer: true, positive: true });
    const x = number(cell(r, 'x'), n, 'X', problems);
    const y = number(cell(r, 'y'), n, 'Y', problems);
    const length = number(cell(r, 'length'), n, 'Length', problems, { positive: true });
    const width = number(cell(r, 'width'), n, 'Width', problems, { positive: true });
    const rotated = boolean(cell(r, 'rotated'), n, 'Rotated?', problems, false);
    if (seqNo == null) problems.push(`Row ${n}: it has no Seq. A plate is cut sequence by sequence and every piece is in one.`);
    if (rowNo == null) problems.push(`Row ${n}: it has no Row. Every piece is in a row of its sequence.`);
    if (x == null) problems.push(`Row ${n}: it has no X, so nothing says where on the plate it sits.`);
    if (y == null) problems.push(`Row ${n}: it has no Y, so nothing says where on the plate it sits.`);
    if ([seqNo, rowNo, x, y, length, width].some((v) => Number.isNaN(v)) || seqNo == null || rowNo == null || x == null || y == null) continue;

    lot.pieces.push({
      rowId, sheetRow: n, cutPlateId, cutPlateCode: cutCode,
      seqNo, rowNo, x, y,
      // Blank means "the rectangle's own size", which is exactly what the
      // verifier fills in, so it is left undefined rather than guessed here.
      ...(length == null ? {} : { length }),
      ...(width == null ? {} : { width }),
      rotated,
    });
  }

  // A lot nobody gave a history to is a plate somebody typed. Said once, here,
  // so the flag means the same thing however the sheet was produced.
  for (const lot of lots.values()) {
    if (lot.isManual == null) lot.isManual = !lot.anyRowId;
    if (lot.source == null) lot.source = 'catalog';
  }
  return { lots: [...lots.values()], stale };
}

/* ===========================================================================
 * Back in — what it would change
 * ======================================================================== */

const CHANGE_FIELDS = [
  ['lot', (p, s) => p.lotNo !== s.lotNo],
  ['plate', (p, s) => Number(p.plateItemId) !== Number(s.plateItemId)],
  ['rectangle', (p, s) => Number(p.cutPlateId) !== Number(s.cutPlateId)],
  ['sequence', (p, s) => Number(p.seqNo) !== Number(s.seqNo)],
  ['row', (p, s) => Number(p.rowNo) !== Number(s.rowNo)],
  ['X', (p, s) => !same(p.x, s.x)],
  ['Y', (p, s) => !same(p.y, s.y)],
  ['length', (p, s) => p.length != null && !same(p.length, s.length)],
  ['width', (p, s) => p.width != null && !same(p.width, s.width)],
  ['rotation', (p, s) => !!p.rotated !== !!s.rotated],
];

/** Where a piece sits, as one string. Used only to recognise a piece nobody moved. */
const spot = (lotNo, plateItemId, p) =>
  `${lotNo}|${plateItemId}|${p.cutPlateId}|${p.seqNo}|${p.rowNo}|${round3(p.x)}|${round3(p.y)}|${p.rotated ? 1 : 0}`;

/**
 * What this sheet does to the saved layout, piece by piece. IDENTITY IS NEVER
 * POSITIONAL: a live Row ID is what matches a row to the piece it came from,
 * whatever order the rows arrive in.
 *
 * A row WITHOUT a live Row ID — one somebody added, or one from a copy of the
 * sheet that has since been superseded — falls back to being recognised by
 * WHERE IT SITS, against a saved piece nothing else has claimed. That is not
 * identity, it is only how the report reads: a piece in exactly the same place
 * on exactly the same plate has not changed, and saying "six pieces taken off,
 * six placed" about a file somebody uploaded twice would be true and useless.
 *
 * This is the half of a dry run somebody actually reads. "Three pieces moved"
 * is a sentence you can agree to; a diff of x/y coordinates is not.
 */
function diffAgainstSaved(lots, savedById) {
  const changes = [];
  const seen = new Set();
  let unchanged = 0;

  // Saved pieces indexed by where they sit, for the fallback. A spot shared by
  // two saved pieces cannot tell them apart, so it is not offered at all.
  const bySpot = new Map();
  for (const [id, s] of savedById) {
    const k = spot(s.lotNo, s.plateItemId, s);
    bySpot.set(k, bySpot.has(k) ? null : id);
  }

  const rows = lots.flatMap((lot) => lot.pieces.map((p) => ({ p, lot, here: { ...p, lotNo: lot.lotNo, plateItemId: lot.plateItemId } })));
  // Live Row IDs first, so a genuine match always beats a lookalike.
  for (const r of rows) if (r.p.rowId != null) { seen.add(r.p.rowId); r.match = r.p.rowId; }
  for (const r of rows) {
    if (r.match != null) continue;
    const id = bySpot.get(spot(r.lot.lotNo, r.lot.plateItemId, r.p));
    if (id != null && !seen.has(id)) { seen.add(id); r.match = id; }
  }

  for (const r of rows) {
    if (r.match == null) {
      changes.push({ kind: 'added', sheetRow: r.p.sheetRow, lot: r.lot.lotNo, cutPlateCode: r.p.cutPlateCode });
      continue;
    }
    const s = savedById.get(r.match);
    const moved = CHANGE_FIELDS.filter(([, differs]) => differs(r.here, s)).map(([name]) => name);
    if (!moved.length) { unchanged += 1; continue; }
    changes.push({ kind: 'changed', rowId: r.match, sheetRow: r.p.sheetRow, lot: r.lot.lotNo, cutPlateCode: r.p.cutPlateCode, changed: moved });
  }
  for (const [id, s] of savedById) {
    if (!seen.has(id)) changes.push({ kind: 'removed', rowId: id, lot: s.lotNo, cutPlateCode: s.cutPlateCode });
  }
  const savedLots = new Set([...savedById.values()].map((s) => s.lotNo));
  const sheetLots = new Set(lots.map((l) => l.lotNo));
  const summary = {
    unchanged,
    added: changes.filter((c) => c.kind === 'added').length,
    changed: changes.filter((c) => c.kind === 'changed').length,
    removed: changes.filter((c) => c.kind === 'removed').length,
    lotsOpened: [...sheetLots].filter((l) => !savedLots.has(l)).length,
    lotsClosed: [...savedLots].filter((l) => !sheetLots.has(l)).length,
    lots: lots.length,
    pieces: lots.reduce((a, l) => a + l.pieces.length, 0),
  };
  return { changes, summary };
}

const sentence = (s) => {
  const bits = [];
  if (s.changed) bits.push(plural(s.changed, 'piece moved', 'pieces moved'));
  if (s.added) bits.push(plural(s.added, 'piece placed', 'pieces placed'));
  if (s.removed) bits.push(plural(s.removed, 'piece taken off', 'pieces taken off'));
  if (s.lotsOpened) bits.push(plural(s.lotsOpened, 'plate opened', 'plates opened'));
  if (s.lotsClosed) bits.push(plural(s.lotsClosed, 'plate closed', 'plates closed'));
  return bits.length ? bits.join(', ') : 'nothing to change';
};

/* ===========================================================================
 * Back in — the accept, and the dry run that is the same accept rolled back
 * ======================================================================== */

/**
 * acceptNesting names a piece by its place in the lot it was handed ("Lot N-002,
 * piece 3"), which is right for the screen and useless in a spreadsheet of four
 * hundred rows. This walks the refusals and adds the sheet row each one is
 * about. The keys are built from the arrays THIS FILE submitted, so a match is
 * exact; if nestingService ever rewords its prefix nothing matches and the
 * problems come back undecorated rather than wrong.
 */
function nameTheRows(problems, lots) {
  const suffixByPrefix = new Map();
  for (const lot of lots) {
    lot.pieces.forEach((p, i) => { suffixByPrefix.set(`Lot ${lot.lotNo}, piece ${i + 1}:`, ` (sheet row ${p.sheetRow}.)`); });
  }
  return problems.map((p) => {
    for (const [prefix, suffix] of suffixByPrefix) if (p.startsWith(prefix)) return p + suffix;
    return p;
  });
}

/** A CfError's collected problems, or its single message when it carries none. */
const problemsOf = (err) => (Array.isArray(err.problems) && err.problems.length ? err.problems : [err.message]);

/**
 * Runs the real accept inside a SAVEPOINT and rolls back to it, so a dry run
 * reports exactly what would happen — including the plate quantities, which
 * only the write path knows — and leaves nothing behind. See the note at the
 * top of this file for why there is no second, read-only verifier.
 */
let trialNo = 0;
async function trialAccept(db, c, orderLineId, plan) {
  // A name of its own each time: re-declaring a savepoint silently deletes the
  // earlier one, and a dry run must not be able to eat somebody else's.
  trialNo += 1;
  const name = `cf_nest_sheet_${trialNo}`;
  await db.query(`SAVEPOINT ${name}`);
  try {
    const out = await acceptNesting(db, c, orderLineId, plan);
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return { ok: true, out };
  } catch (err) {
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    if (err instanceof CfError) return { ok: false, err };
    throw err;
  } finally {
    await db.query(`RELEASE SAVEPOINT ${name}`).catch(() => { /* already gone with the rollback */ });
  }
}

/**
 * Reads a nesting sheet back onto an order line. UPLOADING IT IS ACCEPTING IT.
 *
 *   input.fileBase64 / input.file   the workbook or CSV, base64 (a Buffer is
 *                                   taken too, which is what the tests pass)
 *   input.dryRun                    true reports what it would do and writes
 *                                   nothing at all
 *
 * Returns the accept's own result with the sheet's reading of it attached:
 * where the file came from, what it changes, and — for a dry run — every
 * problem that would stop it, all of them, at once.
 */
export async function importSheet(db, c, orderLineId, input = {}) {
  // This runs acceptNesting, which clears the line's lots and writes new ones,
  // and a dry run rolls that back to a savepoint. Both need the caller's
  // transaction. Handed the pool instead, every statement could land on a
  // different connection and the "dry" run would be half committed.
  if (typeof db.getConnection === 'function') {
    throw invalid('NEEDS_TRANSACTION', 'A nesting sheet is read inside a transaction — pass the connection, not the pool.');
  }
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1';

  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to read — send the file as `fileBase64`.');
  let buffer;
  try { buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64'); }
  catch { throw invalid('BAD_FILE', 'That file could not be read — send it as base64.'); }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');

  const fileRows = await readRows(buffer);
  const headerAt = findHeader(fileRows);
  if (headerAt < 0) {
    throw invalid('WRONG_SHEET', 'That file has no Lot, Cut Plate Code and X columns, so it is not a nesting layout. Download the sheet for this line and edit that copy.');
  }
  const body = fileRows.slice(headerAt + 1);
  if (body.length > MAX_ROWS) throw invalid('TOO_BIG', `A sheet of more than ${MAX_ROWS} pieces is more than this will take in one go.`);

  const problems = [];
  const at = mapHeaders(fileRows[headerAt].cells, problems);
  assertNoProblems(problems, 'That sheet cannot be read.');

  // The saved layout, read BEFORE anything is written, for two things: what a
  // Row ID is allowed to mean, and what this sheet would change.
  const saved = await getNesting(db, c.companyId, orderLineId);
  const savedById = new Map();
  for (const g of saved.groups) {
    for (const n of g.nests) {
      for (const p of n.pieces) {
        savedById.set(p.id, {
          lotNo: n.lotNo, plateItemId: n.plateItemId, cutPlateId: p.cutPlateId, cutPlateCode: p.cutPlateCode,
          seqNo: p.seqNo, rowNo: p.rowNo, x: p.x, y: p.y, length: p.length, width: p.width, rotated: p.rotated,
        });
      }
    }
  }

  // Codes, not ids, because a person types codes — and resolved against THIS
  // company's records, so a code from another tenant is simply not found.
  const codes = [...new Set(body.flatMap((r) => [
    at.plateCode === undefined ? null : r.cells[at.plateCode],
    at.cutPlateCode === undefined ? null : r.cells[at.cutPlateCode],
  ]).filter((v) => !blank(v)).map((v) => String(v).trim()))];
  const [found] = codes.length ? await db.query(
    'SELECT id, code FROM cf_master_records WHERE company_id = ? AND deleted_at IS NULL AND code IN (?)',
    [c.companyId, codes],
  ) : [[]];
  const idByCode = new Map(found.map((m) => [String(m.code).toUpperCase(), m.id]));

  // Every placement this line has EVER had, soft-deleted ones included. A Row
  // ID in here but not in the saved plan came from a copy of the sheet that has
  // since been superseded, which is ordinary; one that is in neither came from
  // somebody else's sheet, which is not.
  const [everRows] = await db.query(
    `SELECT p.id FROM cf_nest_placements p
       JOIN cf_plate_lots l ON l.company_id = p.company_id AND l.id = p.plate_lot_id
      WHERE p.company_id = ? AND l.order_line_id = ?`,
    [c.companyId, orderLineId],
  );
  const knownIds = new Set(everRows.map((r) => r.id));

  const { lots, stale } = buildLots(body, at, { idByCode, savedById, knownIds, problems });
  if (!lots.length && !problems.length) {
    problems.push('That sheet has no pieces on it. The sheet IS the whole plan, so an empty one is not "no change" — it is a layout with nothing placed, which cannot be accepted.');
  }

  const { changes, summary } = problems.length
    ? { changes: [], summary: null }
    : diffAgainstSaved(lots, savedById);

  const head = {
    line: saved.line,
    format: looksXlsx(buffer) ? 'xlsx' : 'csv',
    source: 'sheet',
    dryRun,
    sheetRows: body.filter((r) => r.cells.some((v) => !blank(v))).length,
    // `plateLots`, not `lots`: acceptNesting's own result carries `lots` as a
    // COUNT, and it is spread over this one on the way out. Two keys with the
    // same name and different shapes is a bug waiting for a frontend.
    plateLots: lots.map((l) => ({
      lot: l.lotNo, plateCode: l.plateCode, pieces: l.pieces.length,
      byHand: l.isManual, source: l.source,
      sheetRows: l.sheetRows.length ? [l.sheetRows[0], l.sheetRows[l.sheetRows.length - 1]] : null,
    })),
    summary: summary && { ...summary, stale },
    changes,
    // Null rather than a cheerful "nothing to change" when the sheet could not
    // be read: there is no diff, and saying there is no difference would be a
    // different claim from saying nothing could be compared.
    says: summary ? sentence(summary) : null,
    // Not a problem — said out loud so nobody wonders why a re-upload matched.
    staleRows: stale,
    ...(stale ? { staleNote: `${plural(stale, 'row comes', 'rows come')} from a copy of this sheet that has since been replaced, so ${stale === 1 ? 'it was' : 'they were'} matched by where the piece sits rather than by its Row ID. Download the sheet again to work from the current one.` } : {}),
    accepting: 'Uploading this sheet IS accepting it — there is no separate confirm step.',
  };

  // ---- the cells could not be read ---------------------------------------
  // A dry run REPORTS; it never throws for something the sheet can be fixed to
  // avoid, because seeing the plan and the problems together is the point.
  if (problems.length) {
    if (dryRun) return { ...head, ok: false, applied: false, problems, stoppedAt: 'reading the sheet' };
    assertNoProblems(problems, `That sheet was not applied — ${plural(problems.length, 'problem', 'problems')} to fix first.`);
  }

  const plan = { nests: lots };

  // ---- the layout is checked, and by the ONE verifier ---------------------
  if (dryRun) {
    const trial = await trialAccept(db, c, orderLineId, plan);
    if (!trial.ok) {
      return { ...head, ok: false, applied: false, problems: nameTheRows(problemsOf(trial.err), lots), stoppedAt: 'checking the layout' };
    }
    return { ...head, ok: true, applied: false, problems: [], would: trial.out };
  }

  try {
    const out = await acceptNesting(db, c, orderLineId, plan);
    return { ...head, ...out, ok: true, applied: true, problems: [] };
  } catch (err) {
    if (!(err instanceof CfError)) throw err;
    err.problems = nameTheRows(problemsOf(err), lots);
    throw err;
  }
}
