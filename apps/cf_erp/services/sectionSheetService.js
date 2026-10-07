/**
 * sectionSheetService.js — a line's section nesting as a spreadsheet, out and
 * back in (CF_ERP_CUT_FROM_PLAN.md §11.3). The bar twin of nestingSheetService,
 * and it works the same way: download, edit (or fill from another program),
 * upload — a PREVIEW first (dryRun), every bar checked against our rules, and
 * only a save writes, replacing every bar lot on the line (never a plate lot).
 *
 *   Bar | Source | Stock code | Bar length | Seq | Cut piece code | Length | Start
 *
 * one row per cut. Rows with the same Bar label are one bar (a blank Bar means
 * "the same bar as the row above"). Source is catalog (a bar bought) or offcut
 * (a reusable offcut of the section). Stock code names the bar: a catalog stock
 * item of the pieces' section, or the offcut's number. Bar length is optional
 * and, when given, must be that stock length. Seq orders the cuts along the bar
 * (row order when blank). Length is optional and, when given, must be the cut
 * piece's. START IS OURS: it is worked out from the order, the kerf and the trim,
 * and never read back.
 *
 * WHAT IS CHECKED, all at once: every cut piece known and placed EXACTLY as
 * often as the line needs it (short is refused — a bar plan has no "nest the
 * rest"; over needs `force`), every bar's cuts fit it with kerf between them and
 * trim at both ends, a bar holds one section only, and the stock code is a
 * stock bar of that section (or a free offcut of it).
 */
import ExcelJS from 'exceljs';
import { invalid } from '../lib/errors.js';
import { assertOpen, assertFrozen } from './nestingService.js';
import { sectionSheetContext, savedPlans, writeSectionPlan, planSummary, assertSectionNotCut, getSectionNesting } from './sectionNestingService.js';
import { barLayout } from './sectionPacker.js';

export const BARS_SHEET = 'Bars';
export const NEEDED_SHEET = 'Needed';
export const NOTES_SHEET = 'How to use this';
const MAX_ROWS = 20000;
const HEADER_SEARCH_ROWS = 12;

export const BANNER = 'SAVING AN UPLOAD REPLACES EVERY SECTION BAR ON THIS LINE (plate nests are not touched). '
  + 'Upload shows a preview first: each bar checked for kerf and trim, and every cut piece counted. Nothing is written until you press Save.';

const RO = ' [not read back]';
export const BAR_COLUMNS = [
  { key: 'bar', header: 'Bar', width: 12 },
  { key: 'source', header: 'Source', width: 10 },
  { key: 'stock', header: 'Stock code', width: 34 },
  { key: 'barLength', header: 'Bar length', width: 12 },
  { key: 'seq', header: 'Seq', width: 6 },
  { key: 'cut', header: 'Cut piece code', width: 30 },
  { key: 'length', header: 'Length', width: 10 },
  { key: 'start', header: 'Start', width: 10, readOnly: true },
];
const ALIASES = {
  bar: ['BAR', 'BAR NO', 'LOT', 'STOCK BAR', 'PATTERN'],
  source: ['SOURCE', 'FROM'],
  stock: ['STOCK CODE', 'STOCK', 'BAR CODE', 'SECTION', 'STOCK ITEM', 'RM'],
  barLength: ['BAR LENGTH', 'STOCK LENGTH'],
  seq: ['SEQ', 'SEQUENCE', 'POS', 'ORDER'],
  cut: ['CUT PIECE CODE', 'CUT PIECE', 'PIECE', 'PART', 'BLANK', 'CODE'],
  length: ['LENGTH', 'CUT LENGTH'],
};
export const normaliseHeader = (h) => String(h ?? '').split(/[([]/)[0].replace(/[._:]+$/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const HEADER_KEY = new Map(Object.entries(ALIASES).flatMap(([key, names]) => names.map((n) => [n, key])));

const blank = (v) => v == null || String(v).trim() === '';
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const normCode = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const squash = (s) => normCode(s).replace(/\s+/g, '');
const mm = (n) => `${Number(r3(n)).toLocaleString('en-US')} mm`;
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

export function parseNumber(raw) {
  if (typeof raw === 'number') return raw;
  let s = String(raw ?? '').trim().toLowerCase().replace(/mm$/, '').replace(/\s+/g, '');
  if (s === '') return NaN;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
  return /^[-+]?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
}

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

const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
const HEAD_RO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDDDDD' } };
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const BANNER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE8E8' } };

/* ===========================================================================
 * Out
 * ======================================================================== */

/**
 * The line's SAVED bars as a workbook (Bars / Needed / How to use this). A look
 * is a look: a line with nothing saved gets an empty Bars tab to fill in.
 * Returns { filename, contentType, buffer, rows, bars, saved }.
 */
export async function exportSectionSheet(db, companyId, lineId) {
  const { line, survey } = await sectionSheetContext(db, companyId, lineId);
  const { plans, placed } = await savedPlans(db, companyId, survey);
  const bars = [...plans.values()].flatMap((p) => p?.bars ?? []).sort((a, b) => String(a.lotNo).localeCompare(String(b.lotNo), undefined, { numeric: true }));
  const rows = [];
  for (const b of bars) {
    b.cuts.forEach((c, i) => rows.push({
      bar: b.lotNo, source: b.source, stock: b.source === 'offcut' ? (b.offcutNo ?? b.itemCode ?? '') : (b.itemCode ?? ''),
      barLength: b.lengthMm, seq: i + 1, cut: c.code ?? '', length: c.lengthMm, start: c.xMm,
    }));
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CF ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet(BARS_SHEET, { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = BAR_COLUMNS.map((c) => ({ width: c.width }));
  const banner = ws.addRow([BANNER]);
  ws.mergeCells(1, 1, 1, BAR_COLUMNS.length);
  banner.height = 32;
  banner.getCell(1).font = { bold: true, color: { argb: 'FFB00020' } };
  banner.getCell(1).fill = BANNER_FILL;
  banner.getCell(1).alignment = { vertical: 'middle', wrapText: true };
  const head = ws.addRow(BAR_COLUMNS.map((c) => (c.readOnly ? `${c.header}${RO}` : c.header)));
  head.font = { bold: true };
  BAR_COLUMNS.forEach((c, i) => { head.getCell(i + 1).fill = c.readOnly ? HEAD_RO : HEAD; });
  for (const r of rows) {
    const row = ws.addRow(BAR_COLUMNS.map((c) => r[c.key] ?? ''));
    BAR_COLUMNS.forEach((c, i) => { if (c.readOnly) row.getCell(i + 1).fill = GREY; });
  }

  const need = wb.addWorksheet(NEEDED_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  need.columns = [{ width: 30 }, { width: 30 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 40 }];
  const nh = need.addRow(['Cut piece code', 'Section', 'Length (mm)', 'Needed', 'On bars', 'Stock lengths of the section']);
  nh.font = { bold: true };
  nh.eachCell((cell) => { cell.fill = HEAD_RO; });
  for (const p of survey.profiles.values()) {
    for (const x of p.pieces) need.addRow([x.code, p.label, x.lengthMm, x.quantity, placed.get(x.cutPieceId) ?? 0, p.stock.map((s) => s.code).join(', ')]);
  }

  const s = survey.settings;
  const notes = wb.addWorksheet(NOTES_SHEET);
  notes.columns = [{ width: 30 }, { width: 110 }];
  for (const l of [
    ['How to cut sections to length from this sheet'],
    [],
    [`Line ${line.line_no} of order ${line.order_code}`, bars.length ? 'The Bars tab holds the bars saved now.' : 'Nothing is laid out on bars yet, so the Bars tab is empty — fill it in.'],
    [],
    ['SAVING REPLACES EVERY SECTION BAR ON THIS LINE.', 'Plate nests are not touched. Upload first shows a preview; nothing is written until you press Save.'],
    [],
    ['One row per cut', 'Rows with the same Bar label are one stock bar. A blank Bar means the same bar as the row above.'],
    ['Source', 'catalog (a bar to buy) or offcut (a reusable offcut of that section). Blank = catalog.'],
    ['Stock code', 'The catalog stock bar (see the Needed tab for each section\'s stock lengths), or the offcut number. Only needed on a bar\'s first row.'],
    ['Bar length', 'Optional. When given it must be the stock bar\'s length.'],
    ['Seq', 'The order of the cuts along the bar. Blank = the order of the rows.'],
    ['Cut piece code', 'Our cut piece code (see the Needed tab).'],
    ['Length', 'Optional. When given it must be the cut piece\'s length.'],
    ['Start', 'Written by us, never read back: where the cut starts along the bar.'],
    [],
    ['The rules', `Saw kerf ${s.sawKerfMm} mm between cuts, ${s.endTrimMm} mm trimmed off each end of a bar, leftovers of ${s.minOffcutMm} mm or more kept as offcuts.`],
    ['', 'So the cuts on a bar fit when their lengths + one kerf between each two ≤ bar length − 2 × trim.'],
    ['What blocks a save', 'A cell we cannot read, a cut piece that is not this line\'s, a bar whose cuts do not fit it, a stock code that is not a bar of the pieces\' section,'],
    ['', 'and any cut piece placed fewer times than the line needs (every piece must be on a bar).'],
    ['What needs "Save anyway"', 'More pieces of a cut piece than the line needs.'],
  ]) notes.addRow(l);
  notes.getRow(1).font = { bold: true, size: 14 };
  notes.getRow(5).font = { bold: true, color: { argb: 'FFB00020' } };

  const stem = `SECTION_BARS_${line.order_code}_L${line.line_no}`.replace(/[^\w.-]+/g, '_');
  return {
    filename: `${stem}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    rows: rows.length,
    bars: bars.length,
    saved: bars.length > 0,
  };
}

/* ===========================================================================
 * Back in
 * ======================================================================== */

const looksXlsx = (buf) => buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;

async function readRows(buffer) {
  if (!looksXlsx(buffer)) throw invalid('BAD_FILE', 'That file is not an Excel workbook (.xlsx). Download the section bars sheet for this line and fill that in.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw invalid('BAD_FILE', 'That file starts like a workbook but could not be opened as one.'); }
  const ws = wb.getWorksheet(BARS_SHEET) ?? wb.worksheets.find((w) => ![NEEDED_SHEET, NOTES_SHEET].includes(w.name)) ?? wb.worksheets[0];
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

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    const at = {};
    rows[i].cells.forEach((h, j) => { const key = HEADER_KEY.get(normaliseHeader(h)); if (key && at[key] === undefined) at[key] = j; });
    if (at.bar !== undefined && at.cut !== undefined && at.stock !== undefined) return { index: i, at };
  }
  return null;
}

/**
 * Cells -> bars per profile, every problem collected. Returns
 * { plans: Map profileKey -> { bars }, bars: Bar[], problems, placed: Map cutPieceId -> n, anyRows }.
 */
function readBars(body, at, survey, sheetName) {
  const problems = [];
  const where = (n, col) => `${sheetName} row ${n}${col ? `, ${col}` : ''}`;
  const cell = (r, key) => (at[key] === undefined ? null : r.cells[at[key]]);
  const blanks = [...survey.blanks.values()].filter((b) => b.profileKey);
  const blankBy = new Map();
  for (const b of blanks) if (b.code) { blankBy.set(normCode(b.code), b); blankBy.set(squash(b.code), b); }
  const settings = survey.settings;

  const bars = new Map();
  let current = null;
  for (const r of body) {
    const label = cell(r, 'bar');
    const cutRaw = cell(r, 'cut');
    const stockRaw = cell(r, 'stock');
    if ([label, cutRaw, stockRaw, cell(r, 'length')].every(blank)) continue;
    if (!blank(label)) {
      const key = normCode(label);
      if (!bars.has(key)) bars.set(key, { label: String(label).trim(), rows: [], cuts: [], source: null, stockRaw: null, stockRow: null, barLength: null });
      current = bars.get(key);
    } else if (!current) { problems.push(`${where(r.n, 'Bar')}: it has no Bar, and there is no bar above it to belong to.`); continue; }
    const bar = current;
    bar.rows.push(r.n);
    const src = cell(r, 'source');
    if (!blank(src)) {
      const s = String(src).trim().toLowerCase();
      const v = s.startsWith('off') ? 'offcut' : s.startsWith('cat') || s === 'stock' || s === 'new' ? 'catalog' : null;
      if (!v) problems.push(`${where(r.n, 'Source')}: "${src}" is neither catalog nor offcut.`);
      else if (bar.source && bar.source !== v) problems.push(`${where(r.n, 'Source')}: bar ${bar.label} is both ${bar.source} and ${v}.`);
      else bar.source = v;
    }
    if (!blank(stockRaw)) {
      if (bar.stockRaw != null && squash(bar.stockRaw) !== squash(stockRaw)) problems.push(`${where(r.n, 'Stock code')}: bar ${bar.label} is given two stock codes (${bar.stockRaw} on row ${bar.stockRow}, ${stockRaw} here). A bar is ONE stock bar.`);
      else if (bar.stockRaw == null) { bar.stockRaw = String(stockRaw).trim(); bar.stockRow = r.n; }
    }
    const blRaw = cell(r, 'barLength');
    if (!blank(blRaw)) {
      const v = parseNumber(blRaw);
      if (!(v > 0)) problems.push(`${where(r.n, 'Bar length')}: "${blRaw}" is not a length.`);
      else bar.barLength ??= v;
    }
    if (blank(cutRaw)) continue;
    const b = blankBy.get(normCode(cutRaw)) ?? blankBy.get(squash(cutRaw));
    if (!b) { problems.push(`${where(r.n, 'Cut piece code')}: "${cutRaw}" is not one of this line's section cut pieces. The Needed tab lists them.`); continue; }
    const lenRaw = cell(r, 'length');
    if (!blank(lenRaw)) {
      const v = parseNumber(lenRaw);
      if (!(v > 0)) { problems.push(`${where(r.n, 'Length')}: "${lenRaw}" is not a length.`); continue; }
      if (Math.abs(v - b.lengthMm) > 0.5) { problems.push(`${where(r.n, 'Length')}: ${b.code} is ${mm(b.lengthMm)}, not ${mm(v)}. A cut is the piece itself, not a resize of it.`); continue; }
    }
    const seqRaw = cell(r, 'seq');
    const seq = blank(seqRaw) ? null : parseNumber(seqRaw);
    if (seqRaw != null && !blank(seqRaw) && !Number.isFinite(seq)) { problems.push(`${where(r.n, 'Seq')}: "${seqRaw}" is not a number.`); continue; }
    bar.cuts.push({ blank: b, seq, rowN: r.n });
  }

  // Each bar: its section, its stock, the fit.
  const plans = new Map();
  const out = [];
  const placed = new Map();
  const offcutsBy = new Map();
  for (const p of survey.profiles.values()) for (const o of p.offcuts) offcutsBy.set(o.offcutId, { ...o, profileKey: p.key });
  const usedOffcuts = new Set();
  for (const bar of bars.values()) {
    const first = bar.rows[0];
    if (!bar.cuts.length) { problems.push(`${where(first)}: bar ${bar.label} has no cut pieces on it.`); continue; }
    const keys = new Set(bar.cuts.map((c) => c.blank.profileKey));
    if (keys.size > 1) { problems.push(`${where(first)}: bar ${bar.label} carries pieces of different sections (${[...new Set(bar.cuts.map((c) => survey.profiles.get(c.blank.profileKey)?.label))].join(', ')}). A bar is one section.`); continue; }
    const profile = survey.profiles.get([...keys][0]);
    if (bar.stockRaw == null) { problems.push(`${where(first, 'Stock code')}: bar ${bar.label} does not say which stock bar it is.`); continue; }
    const source = bar.source ?? 'catalog';
    let itemId = null; let lengthMm = null; let offcut = null;
    if (source === 'offcut') {
      const want = squash(bar.stockRaw);
      const idHit = want.match(/^#?(\d+)$/);
      const hits = profile.offcuts.filter((o) => squash(o.offcutNo) === want || (idHit && o.offcutId === Number(idHit[1])));
      if (hits.length !== 1) {
        const other = [...offcutsBy.values()].some((o) => squash(o.offcutNo) === want);
        problems.push(`${where(bar.stockRow, 'Stock code')}: ${hits.length > 1 ? `"${bar.stockRaw}" names ${hits.length} offcuts — write #<id> instead` : other ? `offcut ${bar.stockRaw} is not ${profile.label}` : `"${bar.stockRaw}" is not a free offcut of ${profile.label}`}.`);
        continue;
      }
      offcut = hits[0];
      if (usedOffcuts.has(offcut.offcutId)) { problems.push(`${where(bar.stockRow, 'Stock code')}: offcut ${offcut.offcutNo} is used by two bars — it is one piece of steel.`); continue; }
      usedOffcuts.add(offcut.offcutId);
      itemId = offcut.stockItemId; lengthMm = offcut.lengthMm;
    } else {
      const s = profile.stock.find((x) => squash(x.code) === squash(bar.stockRaw));
      if (!s) {
        const elsewhere = [...survey.stockById.values()].find((it) => squash(it.code) === squash(bar.stockRaw));
        problems.push(`${where(bar.stockRow, 'Stock code')}: ${elsewhere ? `${elsewhere.code} is not a stock bar of ${profile.label}, which the pieces on bar ${bar.label} are cut from` : `"${bar.stockRaw}" is not a stock bar of ${profile.label}`} — its stock bars are ${profile.stock.map((x) => x.code).join(', ') || 'none'}.`);
        continue;
      }
      itemId = s.itemId; lengthMm = s.lengthMm;
    }
    if (bar.barLength != null && Math.abs(bar.barLength - lengthMm) > 0.5) { problems.push(`${where(first, 'Bar length')}: bar ${bar.label} is ${source === 'offcut' ? `offcut ${offcut.offcutNo}` : bar.stockRaw}, ${mm(lengthMm)} long, not ${mm(bar.barLength)}.`); continue; }
    const cuts = bar.cuts.map((c, i) => ({ ...c, order: c.seq ?? i + 1, i })).sort((a, b) => a.order - b.order || a.i - b.i);
    const lay = barLayout(lengthMm, cuts.map((c) => c.blank.lengthMm), survey.settings);
    if (!lay.fits) {
      problems.push(`${where(first)}: the cuts on bar ${bar.label} need ${mm(lay.spanMm)} (${cuts.length} pieces and ${cuts.length - 1} kerf${cuts.length === 2 ? '' : 's'} of ${settings.sawKerfMm} mm), and a ${mm(lengthMm)} bar gives ${mm(lay.usableMm)} after ${settings.endTrimMm} mm trimmed off each end — ${mm(lay.overByMm)} too long.`);
      continue;
    }
    for (const c of cuts) placed.set(c.blank.id, (placed.get(c.blank.id) ?? 0) + 1);
    const shaped = {
      lotId: null, lotNo: bar.label.slice(0, 30), source, itemId, itemCode: survey.stockById.get(Number(itemId))?.code ?? null,
      offcutId: offcut?.offcutId ?? null, offcutNo: offcut?.offcutNo ?? null, lengthMm: r3(lengthMm),
      cuts: cuts.map((c, j) => ({ cutPieceId: c.blank.id, code: c.blank.code, xMm: lay.xs[j], lengthMm: r3(c.blank.lengthMm) })),
      wasteMm: lay.wasteMm, keptOffcutMm: lay.keptOffcutMm,
    };
    if (!plans.has(profile.key)) plans.set(profile.key, { bars: [] });
    plans.get(profile.key).bars.push(shaped);
    out.push(shaped);
  }
  return { plans, bars: out, problems, placed, anyRows: bars.size > 0 };
}

/**
 * POST …/section-nesting/sheet { file (base64), filename, dryRun, force? } ->
 *   { applied, canSave, needsForce, problems, bars, coverage: [{ code, needed, placed }] }
 * plus line, dryRun, message, and (when applied) what was written and the view.
 */
export async function importSectionSheet(db, c, lineId, input = {}) {
  const dryRun = truthy(input.dryRun);
  const force = truthy(input.force);
  const raw = input.file ?? input.fileBase64 ?? input.content;
  if (raw == null || raw === '') throw invalid('NO_FILE', 'There is no sheet to read — send the file as `file` (base64).');
  let buffer;
  try { buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^data:[^,]*,/, ''), 'base64'); } catch { throw invalid('BAD_FILE', 'That file could not be read — send it as base64.'); }
  if (!buffer.length) throw invalid('BAD_FILE', 'That file is empty.');
  const { rows, sheetName } = await readRows(buffer);
  const header = findHeader(rows);
  if (!header) throw invalid('WRONG_SHEET', 'That workbook has no Bar, Stock code and Cut piece code columns, so it is not a section bars sheet. Download the sheet for this line and fill that in.');
  const body = rows.slice(header.index + 1);
  if (body.length > MAX_ROWS) throw invalid('TOO_BIG', `A sheet of more than ${MAX_ROWS} rows is more than this takes in one go.`);

  const { line, survey } = await sectionSheetContext(db, c.companyId, lineId);
  const read = readBars(body, header.at, survey, sheetName);
  const problems = [...survey.problems, ...read.problems];
  if (!read.anyRows) problems.push(`The ${sheetName} tab has no bars on it. Fill in one row per cut.`);
  // A bar's label is its lot number, and a line's lot numbers are shared with its plate nests.
  const [plateLots] = await db.query("SELECT lot_no FROM cf_plate_lots WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL AND kind = 'plate'", [c.companyId, line.id]);
  const plateNos = new Set(plateLots.map((l) => String(l.lot_no).toUpperCase()));
  for (const b of read.bars) if (plateNos.has(String(b.lotNo).toUpperCase())) problems.push(`Bar ${b.lotNo}: that is already the name of a plate nest on this line — give the bar another label.`);
  try { assertOpen(line); assertFrozen(line); await assertSectionNotCut(db, c.companyId, line, survey.places); } catch (e) { problems.push(e.message); }

  const coverage = [];
  const blanks = [...survey.blanks.values()].filter((b) => b.pieces > 0 || read.placed.get(b.id));
  let over = 0;
  for (const b of blanks) {
    const got = read.placed.get(b.id) ?? 0;
    coverage.push({ code: b.code, needed: b.pieces, placed: got });
    if (got < b.pieces) problems.push(`${b.code}: the line needs ${b.pieces} and the sheet places ${got}. Every section cut piece must be on a bar.`);
    if (got > b.pieces) over += 1;
  }
  const canSave = problems.length === 0 && read.bars.length > 0;
  const needsForce = over > 0;
  const say = [];
  if (problems.length) say.push(`${plural(problems.length, 'problem needs', 'problems need')} fixing before this can be saved`);
  say.push(`${plural(read.bars.length, 'bar', 'bars')} read`);
  if (over) say.push(`${plural(over, 'cut piece is', 'cut pieces are')} placed more often than the line needs`);
  const out = {
    line: { id: line.id, lineNo: line.line_no, orderCode: line.order_code },
    dryRun, applied: false, canSave, needsForce, problems,
    bars: read.bars, coverage,
    summary: planSummary(read.bars),
    replaces: 'Saving replaces every section bar on this line (plate nests are not touched).',
    message: `${say.join(', ')}.`,
  };
  if (dryRun || !canSave) return out;
  if (needsForce && !force) return { ...out, message: `${out.message} Not saved: a cut piece is over-covered — save anyway to keep it.` };
  // Saving: the line locked, then the same writer accept uses.
  const [[locked]] = await db.query('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, line.id]);
  void locked;
  const written = await writeSectionPlan(db, c, line, survey, read.plans, { origin: 'imported' });
  return {
    ...out, applied: true, forced: needsForce, written,
    view: await getSectionNesting(db, c.companyId, lineId),
    message: `Saved ${plural(written.lots, 'bar', 'bars')} (${plural(written.pieces, 'piece', 'pieces')}); every earlier section bar on the line was replaced.`,
  };
}
