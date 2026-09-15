/**
 * excelHelpers.js — reading and writing an ExcelJS sheet, written once.
 *
 * `cellVal`/`numVal`/`styledHeader` existed as near-identical copies in
 * `orderItemsImportService.js`, `boqSheetService.js` and `structureSheetService.js`
 * (plus `itemsImportService.js`, `operationsImportService.js` and
 * `resourcesImportService.js`, not touched here — see PLAN.md EU-3). The first
 * two are deleted whole in EU-20; this is where their bodies survive.
 *
 * `cellVal` MERGED FROM TWO SLIGHTLY DIFFERENT COPIES. `boqSheetService`'s
 * additionally unwrapped `richText` cells and, for any other object shape
 * (a hyperlink with no `.text`, a formula with no cached `.result`), returned
 * `null`. `orderItemsImportService`'s copy had no richText case and fell
 * through to `String(c.value)` for an unhandled object, which risks literally
 * writing `"[object Object]"` into a parsed value. The safer of the two
 * (null on anything unrecognised) is the one kept.
 */

import ExcelJS from 'exceljs';

/** A cell's value as a trimmed string, or null. Handles richText/hyperlink/formula shapes. */
export function cellVal(row, col) {
  if (!col) return null;
  const c = row.getCell(col);
  const x = c.value;
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    if (Array.isArray(x.richText)) return x.richText.map((r) => r.text).join('').trim() || null;
    if (x.text !== undefined) return String(x.text).trim() || null;
    if (x.result !== undefined) return String(x.result).trim() || null;
    return null; // e.g. a formula with no cached result, or a hyperlink with no text
  }
  return String(x).trim() || null;
}

/** A cell's value as a finite number, or null. */
export function numVal(row, col) {
  const v = cellVal(row, col);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Write a header row styled the way every fab_erp export sheet does: bold
 * white text on navy, centered, frozen so it stays visible while scrolling.
 *
 * @param {import('exceljs').Worksheet} ws
 * @param {Array<{header:string, width?:number}>} cols
 * @param {{xSplit?:number}} [opts] extra frozen columns (e.g. leading level columns)
 */
export function styledHeader(ws, cols, opts = {}) {
  ws.addRow(cols.map((c) => c.header));
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 20;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 20; });
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: opts.xSplit ?? 0 }];
}

/**
 * A plain "what happened" log sheet for a bulk import — one row per input row,
 * green if it was created, pink otherwise.
 *
 * Not currently called from a surviving file (its one caller, `boqSheetService`,
 * is deleted in EU-20) — moved here so EU-20's replacement importer has it
 * rather than needing to reinvent it.
 *
 * @param {Array<{row, path, name, status, reason}>} rowLog
 */
export async function buildReport(rowLog) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Log');
  ws.addRow(['Row', 'Path', 'Part Name', 'Status', 'Reason']);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  [7, 34, 28, 11, 62].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const r of rowLog) {
    ws.addRow([r.row, r.path, r.name, r.status, r.reason]);
    const fill = r.status === 'Created'
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    ws.lastRow.eachCell((c) => { c.fill = fill; });
  }
  return wb.xlsx.writeBuffer();
}
